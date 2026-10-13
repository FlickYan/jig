#!/usr/bin/env node
// jig's own successes as a training set: the sessions of attempts that passed tests the model never saw,
// from the benchmark suites and from Terminal-Bench, filtered, capped per task, and split by task into
// training and held-out examples, with a manifest of what went in and what was left out. Nothing here
// trains a model (see milestone 26 in the README for what that would take).
//
//   node bench/dataset.ts [--out bench/dataset] [--per-task 5] [--max-tokens 32000]

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ExportedSession, exampleProblems, exportSession, type TrainingExample } from "../src/export.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BENCH = join(ROOT, "bench");

/** A passed attempt with a saved session, before it is checked. */
export interface Found {
  /** The suite whose tasks it is (tasks, evolve, evolve2, explore) or terminal-bench. */
  suite: string;
  task: string;
  model: string;
  /** The run or Terminal-Bench job it came from. */
  run: string;
  session: string;
}

export interface Example {
  suite: string;
  task: string;
  model: string;
  run: string;
  /** About how many tokens the example is (its JSON over 4), and how many of them are the model's own. */
  tokens: number;
  modelTokens: number;
  example: TrainingExample;
}

export interface Options {
  perTask: number;
  maxTokens: number;
  /** Whether a task is held out: its examples go to the held-out set, never the training one. */
  heldOut(suite: string, task: string): boolean;
  load(session: string): ExportedSession | undefined;
}

/** A Terminal-Bench look-up: a command that fetched the benchmark's own repository (as eval/report.py counts it). */
const LOOK_UP = /(harbor-framework|laude-institute)\/terminal-bench/i;

/**
 * The examples that may be trained on, and why the others were left out: a session must export to a
 * valid conversation, must not have reached the benchmark's answers (the repository, or Terminal-Bench's
 * own files), and must fit `maxTokens`; then each task keeps its `perTask` shortest, the efficient
 * successes, and goes whole to training or to the held-out set.
 */
export function build(found: Found[], options: Options) {
  const left = { "no finished reply": 0, "invalid order": 0, "reached the answers": 0, "too long": 0, "over the cap": 0 };
  const byTask = new Map<string, Example[]>();
  for (const f of found) {
    const exported = options.load(f.session);
    if (!exported) {
      left["no finished reply"]++;
      continue;
    }
    if (exampleProblems(exported.example).length) {
      left["invalid order"]++;
      continue;
    }
    const json = JSON.stringify(exported.example);
    const calls = exported.example.messages.flatMap((m) => ("tool_calls" in m && m.tool_calls ? m.tool_calls : []));
    if (json.includes(ROOT) || calls.some((call) => "function" in call && LOOK_UP.test(call.function.arguments))) {
      left["reached the answers"]++;
      continue;
    }
    const tokens = Math.round(json.length / 4);
    if (tokens > options.maxTokens) {
      left["too long"]++;
      continue;
    }
    const own = exported.example.messages.filter((m) => m.role === "assistant").map((m) => JSON.stringify([m.content, "tool_calls" in m ? m.tool_calls : null]));
    const example: Example = { ...f, tokens, modelTokens: Math.round(own.join("").length / 4), example: exported.example };
    const key = `${f.suite}/${f.task}`;
    byTask.set(key, [...(byTask.get(key) ?? []), example]);
  }
  const train: Example[] = [];
  const heldOut: Example[] = [];
  for (const examples of byTask.values()) {
    const kept = examples.sort((a, b) => a.tokens - b.tokens).slice(0, options.perTask);
    left["over the cap"] += examples.length - kept.length;
    (options.heldOut(kept[0].suite, kept[0].task) ? heldOut : train).push(...kept);
  }
  return { train, heldOut, left };
}

/** Which suite a task belongs to, by the folder that has it. */
function suiteOf(task: string): string | undefined {
  return ["tasks", "evolve", "evolve2", "explore"].find((suite) => existsSync(join(BENCH, suite === "tasks" ? "tasks" : join(suite, "tasks"), task)));
}

/**
 * Every passed attempt with a saved session, of jig as it was: runs of evolve candidates and of other
 * system prompts (mini-swe-agent's, through --system-prompt or the adapter's prompts option) are left out.
 */
export function collect(): Found[] {
  const found: Found[] = [];
  const results = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? results(join(dir, e.name)) : e.name.endsWith(".json") ? [join(dir, e.name)] : []));
  for (const file of results(join(BENCH, "results"))) {
    const run = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(run.attempts) || !run.id) continue;
    const candidate = /^evolve-|^replay/.test(run.label ?? "") || /evolve\d*\//.test(run.version ?? "") || (run.settings?.jigArgs ?? []).includes("--system-prompt");
    if (candidate) continue;
    for (const attempt of run.attempts) {
      const suite = suiteOf(attempt.task);
      const session = attempt.session && join(BENCH, "logs", run.id, attempt.session);
      if (attempt.passed && suite && session && existsSync(session)) found.push({ suite, task: attempt.task, model: run.model, run: run.id, session });
    }
  }
  const jobs = join(ROOT, "eval", "jobs");
  for (const job of existsSync(jobs) ? readdirSync(jobs) : []) {
    const config = join(jobs, job, "config.json");
    if (!existsSync(config)) continue;
    const agent = JSON.parse(readFileSync(config, "utf8")).agents?.[0] ?? {};
    const kwargs = agent.kwargs ?? {};
    if (agent.name !== "jig_agent:Jig" || kwargs.prompts || /evolve/.test(String(kwargs.ref ?? ""))) continue;
    for (const trial of readdirSync(join(jobs, job))) {
      const dir = join(jobs, job, trial);
      if (!existsSync(join(dir, "result.json")) || lstatSync(dir).isSymbolicLink()) continue; // links: milestone 24's merged views
      const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
      if (result.verifier_result?.rewards?.reward !== 1) continue;
      const sessions = join(dir, "agent", "jig-home", "sessions");
      const file = existsSync(sessions) ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).find((f) => f.endsWith(".jsonl")) : undefined;
      const model = String(agent.model_name ?? "?").split("/").at(-1)!;
      if (file) found.push({ suite: "terminal-bench", task: result.task_name, model, run: job, session: join(sessions, file) });
    }
  }
  return found;
}

/** The held-out tasks: evolve2's held-out half, Terminal-Bench's held-out sample, and a fifth of the others by name. */
function heldOutTasks(): (suite: string, task: string) => boolean {
  const lines = (file: string) => readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const evolve2 = new Set<string>(JSON.parse(readFileSync(join(BENCH, "evolve2", "split.json"), "utf8")).heldOut);
  const terminalBench = new Set(lines(join(ROOT, "eval", "heldout.txt")));
  return (suite, task) => {
    if (suite === "evolve2") return evolve2.has(task);
    if (suite === "terminal-bench") return terminalBench.has(task);
    return createHash("sha256").update(`${suite}/${task}`).digest()[0] % 5 === 0;
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(BENCH, "dataset") },
      "per-task": { type: "string", default: "5" },
      "max-tokens": { type: "string", default: "32000" },
    },
  });
  const found = collect();
  const { train, heldOut, left } = build(found, { perTask: Number(values["per-task"]), maxTokens: Number(values["max-tokens"]), heldOut: heldOutTasks(), load: exportSession });
  mkdirSync(values.out, { recursive: true });
  const write = (name: string, examples: Example[]) => writeFileSync(join(values.out, name), examples.map((e) => JSON.stringify(e.example)).join("\n") + (examples.length ? "\n" : ""));
  write("train.jsonl", train);
  write("heldout.jsonl", heldOut);
  const sum = (examples: Example[], field: "tokens" | "modelTokens") => examples.reduce((total, e) => total + e[field], 0);
  const describe = (examples: Example[]) => ({
    examples: examples.length,
    tasks: new Set(examples.map((e) => `${e.suite}/${e.task}`)).size,
    tokens: sum(examples, "tokens"),
    modelTokens: sum(examples, "modelTokens"),
    bySuite: Object.fromEntries([...new Set(examples.map((e) => e.suite))].sort().map((suite) => [suite, examples.filter((e) => e.suite === suite).length])),
    byModel: Object.fromEntries([...new Set(examples.map((e) => e.model))].sort().map((model) => [model, examples.filter((e) => e.model === model).length])),
  });
  const manifest = {
    created: new Date().toISOString(),
    policy: { perTask: Number(values["per-task"]), maxTokens: Number(values["max-tokens"]), split: "by task: evolve2's held-out half, eval/heldout.txt, a fifth of the rest by name" },
    found: found.length,
    left,
    train: describe(train),
    heldOut: describe(heldOut),
    examples: [...train.map((e) => ({ split: "train", ...e, example: undefined })), ...heldOut.map((e) => ({ split: "heldout", ...e, example: undefined }))],
  };
  writeFileSync(join(values.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${found.length} passed attempts with a session; left out: ${Object.entries(left).map(([why, n]) => `${n} ${why}`).join(", ")}`);
  for (const [name, part] of [["training", manifest.train], ["held out", manifest.heldOut]] as const) {
    console.log(`${name}: ${part.examples} examples from ${part.tasks} tasks, ~${(part.tokens / 1e6).toFixed(2)}M tokens (${(part.modelTokens / 1e6).toFixed(2)}M the model's own); ${JSON.stringify(part.bySuite)}`);
  }
  console.log(`written to ${relative(process.cwd(), values.out) || "."}: train.jsonl, heldout.jsonl, manifest.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
