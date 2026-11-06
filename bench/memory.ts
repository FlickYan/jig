// The memory benchmark: does what jig keeps from one session make later sessions better? Each scenario in
// bench/memory/ has a first session in which the user says something once (a convention, a fact about
// the project, a preference), then `jig memory reflect --yes`, then follow-up tasks that don't mention it,
// run with what reflection kept and without it (--no-memory, and AGENTS.md as it was), each graded by a
// check. See milestone 13 in docs/milestones.md.
//
//   node bench/memory.ts [--attempts 3] [--model deepseek-flash] [--scenario commit-style] [--keep]

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { costOf } from "../src/prices.ts";
import { hideAnswers } from "./hidden.ts";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const SCENARIOS = join(ROOT, "bench", "memory");
const CLI = join(ROOT, "src", "cli.ts");

interface Followup {
  /** The fixture the task runs in (default: "project", where the first session was). */
  project?: string;
  prompt: string;
  check: string;
}

interface Scenario {
  name: string;
  description: string;
  first: string;
  followups: Followup[];
}

interface Run {
  scenario: string;
  followup: number;
  arm: "with" | "without";
  attempt: number;
  passed: boolean;
  steps: number;
  cost?: number;
}

const { values } = parseArgs({
  options: {
    attempts: { type: "string", default: "3" },
    model: { type: "string", default: "deepseek-flash" },
    scenario: { type: "string", multiple: true, default: [] },
    keep: { type: "boolean", default: false },
  },
});
const attempts = Number(values.attempts);
const model = values.model;

const scenarios: Scenario[] = readdirSync(SCENARIOS)
  .filter((name) => existsSync(join(SCENARIOS, name, "scenario.json")) && (!values.scenario.length || values.scenario.includes(name)))
  .sort()
  .map((name) => ({ name, ...JSON.parse(readFileSync(join(SCENARIOS, name, "scenario.json"), "utf8")) }));

const runs: Run[] = [];
const kept: Record<string, { memories: string[]; instructions: string }> = {};
for (const scenario of scenarios) {
  const work = mkdtempSync(join(tmpdir(), `jig-memory-${scenario.name}-`));
  const home = join(work, "jig-home");
  hideAnswers(home); // the scenarios, with what each follow-up is checked for, are under bench/
  const env = { ...process.env, JIG_HOME: home, NO_COLOR: "1" };
  console.log(`${scenario.name}: ${scenario.description}`);

  // The first session, then reflection on it, which keeps what it proposes (--yes). Every run goes without
  // the wrap-up at the step limit (--no-wrap-up), an extra call earlier runs didn't make, so steps and costs
  // compare with theirs.
  const first = reset(work, scenario, "project");
  await jig(["--yes", "--no-wrap-up", "--model", model, "--", "-"], { cwd: first, env, stdin: scenario.first });
  await jig(["memory", "reflect", "--yes", "--no-wrap-up", "--model", model], { cwd: first, env });
  const memories = listMemories(home);
  const instructions = existsSync(join(first, "AGENTS.md")) ? readFileSync(join(first, "AGENTS.md"), "utf8") : "";
  kept[scenario.name] = { memories, instructions };
  console.log(`  kept ${memories.length} memor${memories.length === 1 ? "y" : "ies"}${instructions ? " and an AGENTS.md" : ""}`);
  for (const memory of memories) console.log(`    ${memory}`);

  for (const [index, followup] of scenario.followups.entries()) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      for (const arm of ["with", "without"] as const) {
        const name = followup.project ?? "project";
        const dir = reset(work, scenario, name, arm === "with" && name === "project" ? instructions : "");
        const stats = join(work, "stats.json");
        rmSync(stats, { force: true });
        await jig(["--yes", "--no-wrap-up", "--model", model, "--stats", stats, ...(arm === "without" ? ["--no-memory"] : []), "--", "-"], { cwd: dir, env, stdin: followup.prompt });
        const passed = check(followup.check, dir);
        const data = existsSync(stats) ? JSON.parse(readFileSync(stats, "utf8")) : {};
        const cost = data.usage ? costOf(model, data.usage) : undefined;
        runs.push({ scenario: scenario.name, followup: index + 1, arm, attempt, passed, steps: data.modelCalls ?? 0, ...(cost !== undefined && { cost }) });
        console.log(`  follow-up ${index + 1}, ${arm.padEnd(7)} ${passed ? "passed" : "failed"} · ${data.modelCalls ?? 0} steps`);
      }
    }
  }
  if (values.keep) console.log(`  kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(`\n${"scenario".padEnd(16)}${"with memory".padEnd(14)}${"without".padEnd(10)}steps (with / without)`);
for (const scenario of scenarios) {
  const mine = runs.filter((run) => run.scenario === scenario.name);
  console.log(`${scenario.name.padEnd(16)}${rate(mine, "with").padEnd(14)}${rate(mine, "without").padEnd(10)}${steps(mine, "with")} / ${steps(mine, "without")}`);
}
console.log(`${"all".padEnd(16)}${rate(runs, "with").padEnd(14)}${rate(runs, "without").padEnd(10)}${steps(runs, "with")} / ${steps(runs, "without")}`);
const resultsDir = join(ROOT, "bench", "results", "memory");
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
writeFileSync(file, `${JSON.stringify({ model, attempts, kept, runs }, null, 1)}\n`);
console.log(`Saved ${file}`);

function rate(list: Run[], arm: Run["arm"]): string {
  const mine = list.filter((run) => run.arm === arm);
  return `${mine.filter((run) => run.passed).length}/${mine.length}`;
}

function steps(list: Run[], arm: Run["arm"]): string {
  const mine = list.filter((run) => run.arm === arm);
  return (mine.reduce((sum, run) => sum + run.steps, 0) / Math.max(1, mine.length)).toFixed(1);
}

/** Puts a fixture back as it started, committed and tagged `start`, at the same path every time. */
function reset(work: string, scenario: Scenario, name: string, instructions = ""): string {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(SCENARIOS, scenario.name, name), dir, { recursive: true, filter: (path) => !/__pycache__|\.pyc$/.test(path) });
  if (instructions) writeFileSync(join(dir, "AGENTS.md"), instructions);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  // Running a fixture's tests writes bytecode beside its modules; that mustn't count as a change to them.
  writeFileSync(join(dir, ".git", "info", "exclude"), "__pycache__/\n*.pyc\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  git("tag", "start");
  return dir;
}

function jig(args: string[], { cwd, env, stdin = "" }: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string }): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGINT"), 600_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end(stdin);
  });
}

function check(command: string, cwd: string): boolean {
  try {
    execFileSync("bash", ["-c", command], { cwd, stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

/** The memories reflection kept, as "scope/name: description". */
function listMemories(home: string): string[] {
  const base = join(home, "memory");
  if (!existsSync(base)) return [];
  const files = readdirSync(base, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".md"));
  return files.map((file) => {
    const description = /^description: (.*)$/m.exec(readFileSync(join(base, file), "utf8"))?.[1] ?? "";
    return `${file.startsWith("user") ? "user" : "project"}/${file.split("/").at(-1)!.slice(0, -3)}: ${description.replace(/^"|"$/g, "")}`;
  });
}
