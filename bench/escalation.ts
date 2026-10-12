#!/usr/bin/env node
// Where --escalate would have handed over, in runs already made: each attempt's saved session is read
// and the loop's own rule (failedTestRun, in src/agent.ts) applied to every step, so a trigger can be
// judged on transcripts before money goes on running it. See milestone 23 in the README.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { failedTestRun } from "../src/agent.ts";
import { formatTable } from "./metrics.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `Usage: node bench/escalation.ts <run>...

A run is a benchmark run's results (bench/results/[<suite>/]<id>.json, its sessions in bench/logs/<id>)
or a Terminal-Bench job (eval/jobs/<job>). For each, how many attempts would have handed over to the
stronger model, how many of those passed anyway, and how many failed with no failed test run to hand
over on.`;

/** The first step, counting every model call, whose test run failed, or undefined if none did. */
export function firstFailedTestRun(session: string): number | undefined {
  // Every message, not what the session ended with: a compaction replaces the history, not the steps.
  const messages: MessageParam[] = [];
  for (const line of readFileSync(session, "utf8").split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message") messages.push(entry.message);
    } catch {
      // blank, or cut off mid-write
    }
  }
  let step = 0;
  for (const [i, message] of messages.entries()) {
    if (message.role !== "assistant") continue;
    step++;
    const blocks = (m?: MessageParam) => (Array.isArray(m?.content) ? m.content : []);
    const results = new Map(blocks(messages[i + 1]).filter((b) => b.type === "tool_result").map((b) => [(b as ToolResult).tool_use_id, b as ToolResult]));
    const calls = blocks(message).filter((b) => b.type === "tool_use") as ToolUse[];
    if (calls.some((call) => results.has(call.id) && failedTestRun(call, results.get(call.id)!))) return step;
  }
  return undefined;
}

interface Attempt {
  passed: boolean;
  session?: string;
}

/** A run's attempts and step limit, from bench/run.ts's results or a Terminal-Bench job's trials. */
function load(path: string): { name: string; maxSteps: number; attempts: Attempt[] } {
  if (path.endsWith(".json")) {
    const run = JSON.parse(readFileSync(path, "utf8"));
    const logs = join(ROOT, "bench", "logs", run.id);
    const attempts = run.attempts.map((a: { passed: boolean; session?: string }) => ({ passed: a.passed, session: a.session && join(logs, a.session) }));
    return { name: run.label, maxSteps: run.settings.maxSteps, attempts };
  }
  // A Terminal-Bench job: a directory a trial, its reward in result.json, jig's session under agent/.
  const attempts: Attempt[] = [];
  for (const trial of readdirSync(path, { withFileTypes: true })) {
    const dir = join(path, trial.name);
    if (!trial.isDirectory() || !existsSync(join(dir, "result.json"))) continue;
    const reward = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).verifier_result?.rewards?.reward;
    if (reward === undefined) continue; // the trial didn't finish
    const sessions = join(dir, "agent", "jig-home", "sessions");
    const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")) : [];
    attempts.push({ passed: reward === 1, session: files[0] && join(sessions, files[0]) });
  }
  return { name: basename(path), maxSteps: Infinity, attempts };
}

function main(): void {
  const paths = process.argv.slice(2);
  if (!paths.length || paths.includes("--help") || paths.includes("-h")) {
    console.log(HELP);
    return;
  }
  const rows = [["run", "attempts", "passed", "would hand over", "and passed anyway", "failed, no failed test run", "no session"]];
  for (const path of paths) {
    const { name, maxSteps, attempts } = load(path);
    let handover = 0, passedAnyway = 0, silent = 0, missing = 0;
    for (const attempt of attempts) {
      if (!attempt.session || !existsSync(attempt.session)) {
        missing++;
        continue;
      }
      const step = firstFailedTestRun(attempt.session);
      // The loop hands over only with a step left for the stronger model.
      if (step !== undefined && step < maxSteps) {
        handover++;
        if (attempt.passed) passedAnyway++;
      } else if (!attempt.passed) silent++;
    }
    const passed = attempts.filter((a) => a.passed).length;
    rows.push([name, String(attempts.length), String(passed), String(handover), String(passedAnyway), String(silent), String(missing)]);
  }
  console.log(formatTable(rows));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
