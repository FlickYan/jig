#!/usr/bin/env node
// Runs an agent on the benchmark tasks and records how it did. See the Benchmark section of the README.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Attempt, estimateCost, formatTable, money, num, parseTranscript, percent, summarize } from "./metrics.ts";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(BENCH);

const HELP = `Usage: node bench/run.ts [options]

Options:
  --agent <name>      jig (default). oracle applies each task's reference solution and noop does nothing;
                      together they check that every task is solvable and not already solved.
  --ref <git ref>     version of jig to run, e.g. m1 (default: the working tree)
  --label <name>      name for this run in the results (default: the ref, or "working-tree")
  --model <id>        model for jig (default: deepseek-flash)
  --tasks <a,b,...>   run only these tasks
  --attempts <n>      runs per task, to see how much results vary (default: 1)
  --concurrency <n>   attempts running at the same time (default: 3)
  --max-steps <n>     jig's step limit per task (default: 40)
  --timeout <s>       seconds before an attempt is stopped (default: 900)
  --keep              keep each attempt's project directory for inspection`;

interface Task {
  id: string;
  /** What the agent is asked to do, worded the way a user would ask. */
  instruction: string;
  /** Run in the project once the agent is done, with the hidden tests in bench_tests/. Exit code 0 = solved. */
  check: string;
  /** What the task exercises. */
  tags: string[];
}

interface RunContext {
  agent: string;
  jigDir?: string;
  model: string;
  logDir: string;
  keep: boolean;
  maxSteps: number;
  timeout: number;
}

// Every task runs in a fresh git repository with the same identity, and no editor or pager to wait on.
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  NO_COLOR: "1",
  PAGER: "cat",
  GIT_EDITOR: "true",
  GIT_AUTHOR_NAME: "jig-bench",
  GIT_AUTHOR_EMAIL: "bench@example.com",
  GIT_COMMITTER_NAME: "jig-bench",
  GIT_COMMITTER_EMAIL: "bench@example.com",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  PYTHONDONTWRITEBYTECODE: "1",
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string", default: "jig" },
      ref: { type: "string" },
      label: { type: "string" },
      model: { type: "string", default: "deepseek-flash" },
      tasks: { type: "string" },
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "3" },
      "max-steps": { type: "string", default: "40" },
      timeout: { type: "string", default: "900" },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const agent = values.agent;
  if (!["jig", "oracle", "noop"].includes(agent)) throw new Error("--agent must be jig, oracle or noop");

  const tasks = await loadTasks(values.tasks?.split(","));
  const jig = agent === "jig" ? await prepareJig(values.ref) : undefined;
  const label = values.label ?? values.ref ?? (agent === "jig" ? "working-tree" : agent);
  const runId = `${new Date().toLocaleString("sv-SE").replace(" ", "T").replace(/:/g, "-")}_${label}`; // local time
  const logDir = join(BENCH, "logs", runId);
  await mkdir(logDir, { recursive: true });
  const settings = { attempts: Number(values.attempts), maxSteps: Number(values["max-steps"]), timeout: Number(values.timeout) };
  const run: RunContext = { agent, jigDir: jig?.dir, model: values.model, logDir, keep: values.keep, ...settings };

  const who = jig ? `jig ${jig.version} with ${values.model}` : `the ${agent} agent`;
  console.log(`Running ${who} on ${tasks.length} tasks × ${settings.attempts} attempt(s)\n`);
  const jobs = tasks.flatMap((task) => Array.from({ length: settings.attempts }, (_, i) => ({ task, attempt: i + 1 })));
  const attempts: Attempt[] = [];
  await pool(jobs, Number(values.concurrency), async ({ task, attempt }) => {
    const result = await runAttempt(task, attempt, run);
    attempts.push(result);
    console.log(`  ${result.passed ? "✓" : "✗"} ${task.id} #${attempt}  ${describe(result)}`);
  });
  attempts.sort((a, b) => a.task.localeCompare(b.task) || a.attempt - b.attempt);
  const summary = summarize(attempts);
  printTable(tasks, attempts);
  console.log(`\nLogs: ${logDir}`);

  if (agent !== "jig") {
    // The reference agents validate the tasks: every task must be solvable, and none already solved.
    const wrong = attempts.filter((a) => a.passed !== (agent === "oracle")).map((a) => a.task);
    if (wrong.length) {
      console.log(`The ${agent} agent should ${agent === "oracle" ? "pass" : "fail"} every task, but not: ${wrong.join(", ")}`);
      process.exitCode = 1;
    }
    return;
  }
  const file = join(BENCH, "results", `${runId}.json`);
  await mkdir(dirname(file), { recursive: true });
  const record = { id: runId, label, version: jig!.version, model: values.model, date: new Date().toISOString(), settings, summary, attempts };
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Saved ${file}\nCompare runs with: npm run bench:report`);
}

async function loadTasks(only?: string[]): Promise<Task[]> {
  const ids = (await readdir(join(BENCH, "tasks"))).filter((id) => existsSync(join(BENCH, "tasks", id, "task.json"))).sort();
  const unknown = only?.filter((id) => !ids.includes(id)) ?? [];
  if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}. The tasks are: ${ids.join(", ")}`);
  const selected = ids.filter((id) => !only || only.includes(id));
  return Promise.all(selected.map(async (id) => ({ id, ...JSON.parse(await readFile(join(BENCH, "tasks", id, "task.json"), "utf8")) })));
}

/** The directory of the jig version to run: the working tree, or a git ref exported to a temp directory. */
async function prepareJig(ref?: string): Promise<{ dir: string; version: string }> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  if (!ref) {
    if (!existsSync(join(ROOT, ".git"))) return { dir: ROOT, version: "working tree" };
    return { dir: ROOT, version: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? "+changes" : ""}` };
  }
  const commit = git("rev-parse", "--short", `${ref}^{commit}`);
  const dir = await mkdtemp(join(tmpdir(), `jig-${ref.replace(/\W/g, "_")}-`));
  git("archive", "--format=tar", `--output=${dir}.tar`, commit);
  execFileSync("tar", ["-xf", `${dir}.tar`, "-C", dir]);
  await rm(`${dir}.tar`);
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules")); // today's dependencies
  return { dir, version: `${ref} (${commit})` };
}

async function runAttempt(task: Task, attempt: number, run: RunContext): Promise<Attempt> {
  const taskDir = join(BENCH, "tasks", task.id);
  const work = await mkdtemp(join(tmpdir(), `jig-bench-${task.id}-`));
  const log = createWriteStream(join(run.logDir, `${task.id}-${attempt}.log`));
  const opts = { cwd: work, env: { ...ENV, TASK_DIR: taskDir }, log };
  try {
    await cp(join(taskDir, "repo"), work, { recursive: true });
    await exec("bash", ["-c", "git init -q -b main && git add -A && git commit -qm 'Starting point'"], { ...opts, timeout: 60 });
    if (existsSync(join(taskDir, "setup.sh"))) await exec("bash", [join(taskDir, "setup.sh")], { ...opts, timeout: 120 });
    const start = (await exec("git", ["rev-parse", "HEAD"], { ...opts, timeout: 60 })).output.trim();

    log.write(`\n$ ${run.agent}: ${task.instruction}\n\n`);
    const started = Date.now();
    let transcript = "";
    let timedOut = false;
    if (run.agent === "jig") {
      const cli = join(run.jigDir!, "src/cli.ts");
      const args = [cli, "-C", work, "--yes", "--max-steps", String(run.maxSteps), "--model", run.model, task.instruction];
      ({ output: transcript, timedOut } = await exec("node", args, { ...opts, timeout: run.timeout }));
    } else if (run.agent === "oracle") {
      await exec("bash", [join(taskDir, "solve.sh")], { ...opts, timeout: 120 });
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;

    log.write("\n--- changes ---\n");
    await exec("bash", ["-c", `git status --short && git diff ${start}`], { ...opts, timeout: 60 });
    // The hidden tests go in only now, so the agent could neither read nor change them.
    await cp(join(taskDir, "tests"), join(work, "bench_tests"), { recursive: true });
    log.write("\n--- check ---\n");
    const check = await exec("bash", ["-c", task.check], { ...opts, timeout: 300 });
    const metrics = parseTranscript(transcript);
    const passed = check.code === 0 && !timedOut;
    log.write(`\n--- ${passed ? "PASSED" : "FAILED"}${timedOut ? " (timed out)" : ""} ---\n`);
    return { task: task.id, attempt, passed, timedOut, seconds, ...metrics, cost: estimateCost(run.model, metrics) };
  } finally {
    if (run.keep) log.write(`Kept the project in ${work}\n`);
    else await rm(work, { recursive: true, force: true });
    log.end();
  }
}

/** Runs a program, copying its output to the log. On timeout it gets Ctrl+C (so jig stops its commands), then SIGKILL. */
function exec(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; log: WriteStream; timeout: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      opts.log.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch {
        // already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGINT");
      setTimeout(() => signal("SIGKILL"), 5000).unref();
    }, opts.timeout * 1000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

function describe(a: Attempt): string {
  const parts = [a.steps !== null && `${a.steps} steps`, a.steps !== null && `${a.toolErrors} tool errors`, a.cost !== null && money(a.cost), `${a.seconds}s`];
  return [...parts, a.timedOut && "timed out"].filter(Boolean).join(" · ");
}

function printTable(tasks: Task[], attempts: Attempt[]): void {
  const row = (name: string, mine: Attempt[]) => {
    const s = summarize(mine);
    const spread = s.passRateSpread ? ` ±${percent(s.passRateSpread)}` : "";
    return [name, `${s.passed}/${s.attempts} (${percent(s.passRate)}${spread})`, num(s.steps), num(s.toolErrors), money(s.cost), `${num(s.seconds, 0)}s`];
  };
  const rows = [
    ["task", "passed", "steps", "tool errors", "cost", "time"],
    ...tasks.map((task) => row(task.id, attempts.filter((a) => a.task === task.id))),
    row("all tasks", attempts),
  ];
  console.log(`\n${formatTable(rows)}`);
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
