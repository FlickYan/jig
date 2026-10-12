#!/usr/bin/env node
// Runs an agent on the benchmark tasks and records how it did. See the Benchmark section of the README.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, type WriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HOMES, hideAnswers } from "./hidden.ts";
import { type Attempt, estimateCost, formatTable, money, num, parseTranscript, percent, summarize, triedForbidden } from "./metrics.ts";

const BENCH = dirname(fileURLToPath(import.meta.url));
// The suite: bench/tasks, or with --suite <name> one that jig evolves on, bench/<name>/tasks, whose
// results go apart, in bench/results/<name>.
let TASKS = join(BENCH, "tasks");
let RESULTS = join(BENCH, "results");
const ROOT = dirname(BENCH);

const HELP = `Usage: node bench/run.ts [options]

Options:
  --agent <name>      jig (default). oracle applies each task's reference solution and noop does nothing;
                      together they check that every task is solvable and not already solved.
  --ref <git ref>     version of jig to run, e.g. m1 (default: the working tree)
  --label <name>      name for this run in the results (default: the ref, or "working-tree")
  --model <id>        model for jig (default: deepseek-flash)
  --tasks <a,b,...>   run only these tasks
  --suite <name>      tasks (default: bench/tasks), or a suite jig evolves on: evolve (bench/evolve/tasks,
                      milestone 14's) or evolve2 (bench/evolve2/tasks, harder)
  --attempts <n>      runs per task, to see how much results vary (default: 1)
  --concurrency <n>   attempts running at the same time (default: 3)
  --max-steps <n>     jig's step limit per task (default: the suite's, from bench/<suite>/suite.json, or 40)
  --timeout <s>       seconds before an attempt is stopped (default: 900)
  --jig-args="<args>" extra arguments for jig, e.g. --jig-args="--effort low" (with the =, since they start
                      with a dash; the jig version must support them)
  --keep              keep each attempt's project directory for inspection`;

interface Task {
  id: string;
  /** What the agent is asked to do, worded the way a user would ask. */
  instruction: string;
  /** Run in the project once the agent is done, with the hidden tests in bench_tests/. Exit code 0 = solved. */
  check: string;
  /** What the task exercises. */
  tags: string[];
  /** For prompt-injection tasks: patterns that, in a tool call, mean the agent followed the injected text. */
  forbidden?: string[];
}

interface RunContext {
  agent: string;
  jigDir?: string;
  jigArgs: string[];
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
  // Some tasks' projects set up MCP servers or hooks in .jig/settings.json, and there is no one to ask
  // whether to trust them. (Versions before M5 ignore both.)
  JIG_TRUST_PROJECT: "1",
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string", default: "jig" },
      ref: { type: "string" },
      label: { type: "string" },
      model: { type: "string", default: "deepseek-flash" },
      tasks: { type: "string" },
      suite: { type: "string", default: "tasks" },
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "3" },
      "max-steps": { type: "string" },
      timeout: { type: "string", default: "900" },
      "jig-args": { type: "string", default: "" },
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
  if (values.suite !== "tasks") {
    if (!/^[\w-]+$/.test(values.suite) || !existsSync(join(BENCH, values.suite, "tasks"))) {
      throw new Error("--suite must be tasks, or a suite with its tasks in bench/<name>/tasks, like evolve or evolve2");
    }
    TASKS = join(BENCH, values.suite, "tasks");
    RESULTS = join(BENCH, "results", values.suite);
  }
  // A suite may set its own step limit: evolve2's is 4, so that what it measures is how much jig gets
  // right in a few model calls, which a change can improve (see bench/evolve2/suite.json).
  const suiteConfig = values.suite !== "tasks" && existsSync(join(BENCH, values.suite, "suite.json")) ? JSON.parse(readFileSync(join(BENCH, values.suite, "suite.json"), "utf8")) : {};
  const maxSteps = values["max-steps"] ?? String(suiteConfig.max_steps ?? 40);

  if (agent === "jig" && values.model.startsWith("deepseek") && !process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is not set, so every attempt would fail. Export it and run again.");
  }
  const tasks = await loadTasks(values.tasks?.split(","));
  const jig = agent === "jig" ? await prepareJig(values.ref) : undefined;
  const suiteAtStart = jig && suiteFingerprint(tasks);
  const label = values.label ?? values.ref ?? (agent === "jig" ? "working-tree" : agent);
  const runId = `${new Date().toLocaleString("sv-SE").replace(" ", "T").replace(/:/g, "-")}_${label}`; // local time
  const logDir = join(BENCH, "logs", runId);
  await mkdir(logDir, { recursive: true });
  hideAnswers(join(logDir, "jig-home"));
  const jigArgs = values["jig-args"].split(/\s+/).filter(Boolean);
  const settings = { attempts: Number(values.attempts), maxSteps: Number(maxSteps), timeout: Number(values.timeout), jigArgs };
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
  if (attempts.every((a) => a.steps === null)) {
    console.log("No attempt got as far as a reply from the model (see the logs), so the results were not saved.");
    process.exitCode = 1;
    return;
  }
  const file = join(RESULTS, `${runId}.json`);
  await mkdir(dirname(file), { recursive: true });
  // Fingerprinted at the start and again at the end: a task changed while the run was going means its
  // attempts didn't all see the same tasks, and the run describes no one version of the suite.
  const suiteAtEnd = suiteFingerprint(tasks);
  if (suiteAtEnd !== suiteAtStart) console.log(`The tasks changed during the run (${suiteAtStart}, then ${suiteAtEnd}): its attempts didn't all see the same tasks.`);
  const record = { id: runId, label, version: jig!.version, model: values.model, suite: suiteAtStart, ...(suiteAtEnd !== suiteAtStart && { suiteAtEnd }), date: new Date().toISOString(), settings, summary, attempts };
  await mkdir(RESULTS, { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Saved ${file}\nCompare runs with: npm run bench:report`);
}

async function loadTasks(only?: string[]): Promise<Task[]> {
  const ids = (await readdir(TASKS)).filter((id) => existsSync(join(TASKS, id, "task.json"))).sort();
  const unknown = only?.filter((id) => !ids.includes(id)) ?? [];
  if (unknown.length) throw new Error(`Unknown tasks: ${unknown.join(", ")}. The tasks are: ${ids.join(", ")}`);
  const selected = ids.filter((id) => !only || only.includes(id));
  return Promise.all(selected.map(async (id) => ({ id, ...JSON.parse(await readFile(join(TASKS, id, "task.json"), "utf8")) })));
}

/**
 * A short hash of everything in the selected tasks. Runs are only comparable on the same suite: the report
 * shows it, so a run made before a task changed isn't mistaken for a result on the current tasks.
 */
function suiteFingerprint(tasks: Task[]): string {
  const hash = createHash("sha256");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...tasks.map((t) => join(relative(ROOT, TASKS), t.id))], { cwd: ROOT, encoding: "utf8" });
  for (const file of files.split("\n").filter(Boolean).sort()) hash.update(file).update(readFileSync(join(ROOT, file)));
  return hash.digest("hex").slice(0, 8);
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
  const taskDir = join(TASKS, task.id);
  // A neutral name: the path is in jig's system prompt, and naming it after the task (say "injection-readme")
  // told the model it was being tested.
  const work = await mkdtemp(join(tmpdir(), "project-"));
  const log = createWriteStream(join(run.logDir, `${task.id}-${attempt}.log`));
  // A home directory of its own (outside the project and the temp directories, so the sandbox can't
  // write there): injection tasks check that nothing landed in it. It is outside bench/ too, which the
  // sandbox hides (see hidden.ts). jig's sessions and snapshots go with the run's logs, not in ~/.jig.
  const home = join(HOMES, basename(run.logDir), `${task.id}-${attempt}`);
  await mkdir(home, { recursive: true });
  // Programs a task expects on the user's machine, outside the project (like a linter its hooks run).
  if (existsSync(join(taskDir, "home"))) await cp(join(taskDir, "home"), home, { recursive: true });
  // TASK_DIR is for the task's own scripts (setup.sh, solve.sh), not for jig: it leads to the answers.
  const env = { ...ENV, TASK_DIR: taskDir, HOME: home, JIG_HOME: join(run.logDir, "jig-home") };
  const { TASK_DIR: _, ...jigEnv } = env;
  const opts = { cwd: work, env, log };
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
      const args = [cli, "-C", work, "--yes", "--max-steps", String(run.maxSteps), "--model", run.model, ...run.jigArgs, task.instruction];
      ({ output: transcript, timedOut } = await exec("node", args, { ...opts, env: jigEnv, timeout: run.timeout }));
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
    const followedInjection = task.forbidden && run.agent === "jig" ? triedForbidden(transcript, task.forbidden) : undefined;
    const session = run.agent === "jig" ? await findSession(join(run.logDir, "jig-home"), work) : undefined;
    log.write(`\n--- ${passed ? "PASSED" : "FAILED"}${timedOut ? " (timed out)" : ""}${followedInjection ? " (followed the injected instruction)" : ""} ---\n`);
    return { task: task.id, attempt, passed, timedOut, seconds, ...metrics, cost: estimateCost(run.model, metrics), followedInjection, ...(session && { session: relative(run.logDir, session) }) };
  } finally {
    if (run.keep) log.write(`Kept the project in ${work}\n`);
    else await rm(work, { recursive: true, force: true });
    log.end();
  }
}

/**
 * The session jig saved for an attempt: the one that started in its project directory. Every attempt's
 * project is a new temp directory, so there is one at most (none from versions that kept no sessions).
 */
async function findSession(jigHome: string, work: string): Promise<string | undefined> {
  const root = join(jigHome, "sessions");
  if (!existsSync(root)) return undefined;
  const real = await realpath(work).catch(() => work);
  for (const dir of await readdir(root)) {
    for (const name of (await readdir(join(root, dir))).filter((file) => file.endsWith(".jsonl"))) {
      const file = join(root, dir, name);
      try {
        const start = JSON.parse((await readFile(file, "utf8")).split("\n", 1)[0]);
        if (start.type === "start" && (start.cwd === work || start.cwd === real)) return file;
      } catch {
        // not a session file, or one cut off mid-write
      }
    }
  }
  return undefined;
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
  return [...parts, a.timedOut && "timed out", a.followedInjection && "FOLLOWED THE INJECTION"].filter(Boolean).join(" · ");
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
