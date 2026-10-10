import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Usage } from "./agent.ts";
import { type Api, createModel } from "./model.ts";
import { jigHome } from "./paths.ts";
import { costOf } from "./prices.ts";
import { discoverSkills, type Skill } from "./skills.ts";
import * as ui from "./ui.ts";

// `jig skills test`: does a skill help? Each eval runs as a one-shot jig task in a fresh project, once with
// the skill and once without it, and is graded by its check command and by a model judging its
// expectations. The format is that of Anthropic's skill-creator (evals/evals.json), plus `check`.

/** One test task for a skill. */
export interface SkillEval {
  id: number | string;
  prompt: string;
  expected_output?: string;
  /** Input files, relative to the skill's folder, copied into the project the task starts from. */
  files?: string[];
  /** Statements about the result, judged by a model from the changes and the agent's final message. */
  expectations?: string[];
  /** jig's addition: a shell command run in the project afterwards; exit code 0 means the result is right. */
  check?: string;
}

export function readEvals(skill: Skill): SkillEval[] {
  const path = join(skill.dir, "evals", "evals.json");
  if (!existsSync(path)) throw new Error(`The skill "${skill.name}" has no evals: write some in ${path} (the skill-writer skill describes the format).`);
  const { evals } = JSON.parse(readFileSync(path, "utf8")) as { evals?: SkillEval[] };
  if (!Array.isArray(evals) || !evals.length) throw new Error(`${path} lists no evals.`);
  for (const [index, item] of evals.entries()) {
    if (typeof item.prompt !== "string" || !item.prompt.trim()) throw new Error(`Eval ${item.id ?? index + 1} in ${path} has no prompt.`);
  }
  return evals.map((item, index) => ({ ...item, id: item.id ?? index + 1 }));
}

/** What the grader decided about one expectation (the fields of skill-creator's grading.json). */
export interface Grade {
  text: string;
  passed: boolean;
  evidence: string;
}

export interface EvalRun {
  eval: SkillEval["id"];
  arm: "with" | "without";
  attempt: number;
  passed: boolean;
  check?: boolean;
  grades?: Grade[];
  /** Whether the model loaded the skill's instructions. */
  loaded: boolean;
  steps: number;
  usage: Usage;
  cost?: number;
  seconds: number;
  error?: string;
}

export interface TestOptions {
  attempts: number;
  model: string;
  api?: string;
  /** Seconds before a run is stopped. */
  timeout?: number;
  /** jig's CLI, to run each eval with (default: the one running now). */
  cli?: string;
  /** Extra environment for the runs (tests point jig at a fake API this way). */
  env?: NodeJS.ProcessEnv;
  /** Grades expectations (default: the model, asked to judge); tests pass their own. */
  grade?: (evalCase: SkillEval, evidence: string, finalMessage: string) => Promise<Grade[]>;
}

/** Runs a skill's evals with and without it, prints the comparison, and saves every run. */
export async function testSkill(project: string, name: string, options: TestOptions): Promise<EvalRun[]> {
  const skill = discoverSkills(project).skills.find((s) => s.name === name);
  if (!skill) throw new Error(`This project sees no skill "${name}" (jig skills list shows the ones it does).`);
  const evals = readEvals(skill);
  ui.println(`Testing ${skill.name}: ${evals.length} eval${evals.length === 1 ? "" : "s"} × ${options.attempts} attempt${options.attempts === 1 ? "" : "s"}, with the skill and without it (${options.model})`);
  const runs: EvalRun[] = [];
  for (const evalCase of evals) {
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      for (const arm of ["with", "without"] as const) {
        const run = await runEval(skill, evalCase, arm, attempt, options);
        runs.push(run);
        const verdict = run.error ? `error: ${run.error}` : run.passed ? "passed" : "failed";
        ui.println(ui.dim(`  eval ${evalCase.id}, ${arm.padEnd(7)} ${verdict}${run.loaded ? " (loaded the skill)" : ""} · ${run.steps} steps · ${run.cost === undefined ? "?" : `$${run.cost.toFixed(4)}`}`));
      }
    }
  }
  printSummary(runs);
  const dir = join(jigHome(), "skill-evals", skill.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ skill: skill.name, model: options.model, attempts: options.attempts, runs }, null, 1)}\n`);
  ui.println(ui.dim(`Saved to ${file}`));
  return runs;
}

async function runEval(skill: Skill, evalCase: SkillEval, arm: "with" | "without", attempt: number, options: TestOptions): Promise<EvalRun> {
  const work = mkdtempSync(join(tmpdir(), "jig-eval-"));
  const project = join(work, "project");
  // A home of its own, so the user's other skills and settings play no part.
  const home = join(work, "home");
  const started = Date.now();
  try {
    mkdirSync(project);
    mkdirSync(join(home, ".jig"), { recursive: true });
    for (const [from, to] of evalFileTargets(evalCase.files ?? [], (file) => statSync(join(skill.dir, file)).isDirectory())) {
      cpSync(join(skill.dir, from), join(project, to), { recursive: true });
    }
    const baseline = gitBaseline(project);
    if (arm === "with") cpSync(skill.dir, join(home, ".jig", "skills", skill.name), { recursive: true });
    const statsFile = join(work, "stats.json");
    const args = [
      options.cli ?? process.argv[1],
      "--yes",
      "--stats", statsFile,
      "--model", options.model,
      ...(options.api ? ["--api", options.api] : []),
      ...(arm === "without" ? ["--hide-skill", skill.name] : []),
      "--", "-",
    ];
    const env = { ...process.env, ...options.env, HOME: home, JIG_HOME: join(home, ".jig"), NO_COLOR: "1" };
    const timedOut = await runJig(args, { cwd: project, env, stdin: evalCase.prompt, timeout: options.timeout ?? 600 });
    const stats = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, "utf8")) : {};
    const usage: Usage = stats.usage ?? { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

    const check = evalCase.check === undefined ? undefined : runCheck(evalCase.check, project, env);
    const expectations = evalCase.expectations?.length
      ? evalCase.expectations
      : evalCase.check === undefined && evalCase.expected_output
        ? [`The result matches what was expected: ${evalCase.expected_output}`]
        : [];
    const grade = options.grade ?? judge(options);
    const session = sessionRecord(join(home, ".jig"));
    const grades = expectations.length
      ? await grade({ ...evalCase, expectations }, `${evidence(project, baseline, expectations)}\n\nWhat the agent ran, with the output:\n${session.transcript || "(nothing)"}`, session.finalMessage)
      : undefined;
    return {
      eval: evalCase.id,
      arm,
      attempt,
      passed: !timedOut && check !== false && (grades?.every((g) => g.passed) ?? true) && (check !== undefined || grades !== undefined),
      ...(check !== undefined && { check }),
      ...(grades && { grades }),
      loaded: (stats.toolCalls?.skill ?? 0) > 0,
      steps: stats.modelCalls ?? 0,
      usage,
      ...(costOf(options.model, usage) !== undefined && { cost: costOf(options.model, usage) }),
      seconds: (Date.now() - started) / 1000,
      ...(timedOut && { error: `timed out after ${options.timeout ?? 600}s` }),
      ...(stats.error && { error: stats.error }),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Where an eval's files go in the project it starts from: below the folder they share, keeping their
 * layout (evals/files/basic/src/app.py becomes src/app.py), and a folder given on its own becomes the
 * project itself.
 */
export function evalFileTargets(files: string[], isDirectory: (file: string) => boolean): [string, string][] {
  if (!files.length) return [];
  if (files.length === 1 && isDirectory(files[0])) return [[files[0], "."]];
  const folders = files.map((file) => dirname(file).split(sep));
  const shared = folders.reduce((common, parts) => {
    const differs = common.findIndex((part, i) => part !== parts[i]);
    return differs === -1 ? common : common.slice(0, differs);
  });
  const base = shared.join(sep);
  return files.map((file) => [file, relative(base, file)]);
}

/** A commit of the starting point, so what the task changed can be shown as a diff. Returns its hash. */
function gitBaseline(project: string): string | undefined {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=jig", "-c", "user.email=jig@localhost", "commit", "-q", "--allow-empty", "-m", "start");
    return git("rev-parse", "HEAD");
  } catch {
    return undefined; // without git, the grader sees no diff
  }
}

/** Runs jig, the task on stdin. On timeout it gets Ctrl+C, so it stops its commands, then SIGKILL. */
function runJig(args: string[], { cwd, env, stdin, timeout }: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeout: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "ignore", "ignore"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeout * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(timedOut);
    });
    child.stdin.end(stdin);
  });
}

function runCheck(command: string, project: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync("bash", ["-c", command], { cwd: project, env, stdio: "ignore", timeout: 300_000 });
    return true;
  } catch {
    return false;
  }
}

const MAX_EVIDENCE = 30_000;

/**
 * What the task changed, for the grader: commits and tags it made, what it left uncommitted, and the
 * whole diff from the starting point (committed or not, new files included).
 */
function evidence(project: string, baseline: string | undefined, expectations: string[]): string {
  if (!baseline) return "(the changes couldn't be listed: git is missing)";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8", maxBuffer: 50_000_000 });
  try {
    const commits = git("log", "--format=%h %s", `${baseline}..HEAD`);
    const tags = git("tag", "-l", "-n1");
    const uncommitted = git("status", "--short");
    git("add", "-A");
    const diff = clip(git("diff", "--cached", baseline), MAX_EVIDENCE);
    // A diff shows only changed lines: a statement about a whole file needs the file as it ended up.
    const changed = git("diff", "--cached", "--name-only", baseline).split("\n").filter(Boolean);
    const named = (git("ls-files").split("\n").filter(Boolean)).filter((file) => expectations.some((text) => text.includes(file)));
    let budget = MAX_FILES;
    const files = [...new Set([...named, ...changed])].flatMap((file) => {
      const path = join(project, file);
      if (budget <= 0 || !existsSync(path) || statSync(path).size > 20_000) return [];
      const content = clip(readFileSync(path, "utf8"), 5000);
      budget -= content.length;
      return [`--- ${file}\n${content}`];
    });
    return [
      `Commits made:\n${commits || "(none)"}`,
      `Tags (with their messages):\n${tags || "(none)"}`,
      `Uncommitted changes:\n${uncommitted || "(none)"}`,
      `The diff from the starting point:\n${diff || "(empty)"}`,
      `The files the task changed or the statements name, as they ended up:\n${files.join("\n") || "(none)"}`,
    ].join("\n\n");
  } catch (err) {
    return `(the changes couldn't be listed: ${(err as Error).message.split("\n")[0]})`;
  }
}

const MAX_FILES = 20_000;
const MAX_OUTPUT = 1500;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[... cut]` : text;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };

/**
 * From the session the agent saved: its last message, and the commands and tool calls it made with what
 * they printed, so the grader can see a check's output rather than take the agent's word for it.
 */
function sessionRecord(home: string): { finalMessage: string; transcript: string } {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return { finalMessage: "", transcript: "" };
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".jsonl"));
  let finalMessage = "";
  const calls = new Map<string, string>();
  const steps: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line) continue;
      const message = (JSON.parse(line) as { message?: { role?: string; content?: unknown } }).message;
      const blocks = (Array.isArray(message?.content) ? message.content : []) as Block[];
      if (message?.role === "assistant") {
        const text = typeof message.content === "string" ? message.content : blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text.trim()) finalMessage = text;
        for (const block of blocks) if (block.type === "tool_use") calls.set(block.id!, `${block.name} ${JSON.stringify(block.input)}`);
      }
      for (const block of blocks) {
        if (block.type !== "tool_result" || !calls.has(block.tool_use_id!)) continue;
        const output = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((part: Block) => part.text ?? "").join("") : "";
        steps.push(`$ ${clip(calls.get(block.tool_use_id!)!, 400)}\n${clip(output, MAX_OUTPUT)}`);
      }
    }
  }
  return { finalMessage, transcript: clip(steps.slice(-15).join("\n\n"), MAX_EVIDENCE) };
}

const JUDGE = `You grade the work of an AI coding agent. You get the task, the statements a good result makes true, the agent's final message, what it changed in the project (commits, tags, the diff, and the files as they ended up), and the commands it ran with their output. For each statement, decide from that evidence alone whether it is true: if the evidence doesn't show it, it is false. Claims in the agent's message count only when the changes or the command output bear them out. Today's date is in the prompt; don't use your own idea of it.`;

/** Grades expectations with the model: one call per run, answered as JSON. */
function judge({ model, api }: TestOptions): (evalCase: SkillEval, changes: string, message: string) => Promise<Grade[]> {
  return async (evalCase, changes, message) => {
    const callModel = createModel({ model, ...(api && { api: api as Api }), system: JUDGE, tools: [], quiet: true });
    const statements = evalCase.expectations!.map((text, index) => `${index + 1}. ${text}`).join("\n");
    const today = new Date().toLocaleDateString("en-CA");
    const prompt = `Today's date: ${today}\n\nTask:\n${evalCase.prompt}\n\nStatements:\n${statements}\n\nThe agent's final message:\n${message || "(none)"}\n\nWhat it changed:\n${changes}\n\nAnswer with a JSON array only, one object per statement, in order: {"text": the statement, "passed": true or false, "evidence": where you saw it, or why not}.`;
    try {
      const { message: reply } = await callModel([{ role: "user", content: prompt }]);
      const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const grades = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? "") as Grade[];
      return evalCase.expectations!.map((statement, index) => ({ text: statement, passed: grades[index]?.passed === true, evidence: String(grades[index]?.evidence ?? "") }));
    } catch (err) {
      return evalCase.expectations!.map((text) => ({ text, passed: false, evidence: `couldn't grade: ${(err as Error).message}` }));
    }
  };
}

function printSummary(runs: EvalRun[]): void {
  const arm = (name: "with" | "without") => runs.filter((run) => run.arm === name);
  const rate = (list: EvalRun[]) => `${list.filter((run) => run.passed).length}/${list.length}`;
  const graded = (list: EvalRun[]) => {
    const grades = list.flatMap((run) => run.grades ?? []);
    return grades.length ? `${grades.filter((g) => g.passed).length}/${grades.length}` : "-";
  };
  const average = (list: EvalRun[], value: (run: EvalRun) => number) => (list.length ? list.reduce((sum, run) => sum + value(run), 0) / list.length : 0);
  const rows: [string, (list: EvalRun[]) => string][] = [
    ["passed", rate],
    ["check passed", (list) => (list.some((run) => run.check !== undefined) ? `${list.filter((run) => run.check === true).length}/${list.filter((run) => run.check !== undefined).length}` : "-")],
    ["expectations met", graded],
    ["steps", (list) => average(list, (run) => run.steps).toFixed(1)],
    ["cost", (list) => `$${average(list, (run) => run.cost ?? 0).toFixed(4)}`],
  ];
  ui.println();
  ui.println(`  ${"".padEnd(18)}${"with the skill".padEnd(18)}without`);
  for (const [label, value] of rows) ui.println(`  ${label.padEnd(18)}${value(arm("with")).padEnd(18)}${value(arm("without"))}`);
  ui.println(`  ${"loaded the skill".padEnd(18)}${`${arm("with").filter((run) => run.loaded).length}/${arm("with").length}`}`);
}
