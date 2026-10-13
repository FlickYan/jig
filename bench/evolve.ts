// jig evolves itself: find what goes wrong, or wastes steps, in its own benchmark attempts; let jig change
// its code to do better; and keep the change only if a referee the change can't touch says it helps. See
// milestone 14 in docs/milestones.md.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { addUsage, type Usage } from "../src/agent.ts";
import { createModel } from "../src/model.ts";
import { costOf } from "../src/prices.ts";
import { createSandbox } from "../src/sandbox.ts";
import { failingTests, readAttemptLog, replySummary, taskWords } from "./evolve-analysis.ts";
import { changedFiles, commitPatch, patchOf, workspace } from "./evolve-workspace.ts";
import { attemptsOf, deepseekBalance, MIN_BALANCE_CNY, nextStart, refusedByApi, runOrder, type TerminalBenchVerdict, terminalBenchVerdict } from "./evolve-terminal-bench.ts";
import { HOMES, hideAnswers } from "./hidden.ts";
import { type Attempt, compare, type Comparison, forbiddenFiles, judgeHeldOut, judgeTrain, leakedWords, passRates, simulateReferee, split, type Verdict } from "./evolve-referee.ts";

const HELP = `Usage: node bench/evolve.ts <command> [options]

Commands:
  split        split the suite into training and held-out tasks, from the latest baseline run
               (node bench/run.ts --suite evolve2 --attempts 3 --label baseline)
  calibrate    how often the referee would be fooled, from every baseline run so far (more runs:
               --label baseline-<name>), saved with the split; --compare-with names the runs
               candidates are compared with from then on (after jig itself changed, say)
  analyze      diagnose the baseline's training attempts: what failed, where steps went (--from
               <label>: another baseline run's, which candidates mustn't then be compared with)
  propose      jig changes a copy of itself; the change goes on a new branch, <suite>/<n>
  score <n>    the referee: changed files, task words, jig's tests, the training tasks, the held-out tasks,
               compared with the baseline runs the analysis didn't see (run the baseline again with
               --label baseline-<name> before scoring; there is no comparing with the run it saw)
  run          propose and score candidates, each for a cause the analysis found that no earlier one took
  tbcheck <n>  Terminal-Bench for a candidate the referee accepted: it and jig where it branched, on the
               tasks in eval/subset.txt, in alternating rounds, each started only when it can finish
               outside DeepSeek's peak hours (weekdays 9-12 and 14-18); needs Docker, about 9 hours
  list         every candidate so far and its verdict

Options:
  --suite <name>      evolve2 (default: bench/evolve2, the harder suite) or evolve (milestone 14's)
  --model <id>        model for the analysis, the candidates and the runs (default: deepseek-flash)
  --attempts <n>      attempts per task when scoring (default: 3, as in the baseline)
  --candidates <n>    candidates for run (default: 3)
  --target <where>    for run and propose: any (the default), or loop: the loop and tools only, not the prompt
  --budget <usd>      run stops once candidates have cost this much (default: 1.50)
  --seed <n>          for the split (default: 14)
  --from <label>      for analyze: the baseline run to diagnose (default: the one the split came from)
  --compare-with <labels>  for calibrate: the baseline runs candidates are compared with, by label
                      (baseline-a,baseline-b); without it, every run the analysis didn't see
  --rounds <n>        Terminal-Bench rounds for tbcheck, each side once a round (default: 2)
  --tb-tasks <a,b>    tbcheck on these tasks only: a smoke test, whose verdict isn't recorded

Candidates branch from HEAD and are judged by the main checkout: its tests, tasks and runner, never the
candidate's. Nothing here merges one: an accepted candidate waits on its branch for a person.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    suite: { type: "string", default: "evolve2" },
    model: { type: "string", default: "deepseek-flash" },
    attempts: { type: "string", default: "3" },
    candidates: { type: "string", default: "3" },
    budget: { type: "string", default: "1.50" },
    rounds: { type: "string", default: "2" },
    "compare-with": { type: "string" },
    target: { type: "string", default: "any" },
    from: { type: "string" },
    "tb-tasks": { type: "string" },
    seed: { type: "string", default: "14" },
    help: { type: "boolean", short: "h", default: false },
  },
});
const model = values.model;
const suite = values.suite;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Each suite keeps its own tasks, split, analysis and archive, its results and its logs.
const EVOLVE = join(ROOT, "bench", suite);
const TASKS = join(EVOLVE, "tasks");
const ARCHIVE = join(EVOLVE, "archive");
const RESULTS = join(ROOT, "bench", "results", suite);
const LOGS = join(ROOT, "bench", "logs", suite);
const CLI = join(ROOT, "src", "cli.ts");
/** jig's tests, made to fail rather than hang where something they need is missing. */
const TESTS = "node --test --test-timeout=30000 --test-force-exit --test-reporter=spec test/*.test.ts";
if (!/^[\w-]+$/.test(suite) || !existsSync(TASKS)) throw new Error(`No suite ${suite}: bench/${suite}/tasks doesn't exist.`);

interface Split {
  seed: number;
  /** The baseline run's results file, relative to the repository. */
  baseline: string;
  train: string[];
  heldOut: string[];
  /** How often the referee would accept a change that does nothing, one that cuts cost by 25%, or one that
   * fixes a third of the failures, judged against the baseline runs named (see calibrate); and, in
   * against, how often against the runs candidates are compared with, as those came out. */
  acceptance: { baselines: string[]; nothing: number; cheaper25: number; fixesThird?: number; against?: { runs: string[]; nothing: number; fixesThird: number } };
  /** What it said before milestone 14's candidates ran: the first baseline held fixed, and any more solved
   * on the held-out tasks enough to be accepted. */
  acceptanceBefore?: { nothing: number; cheaper25: number };
  /** The labels of the runs candidates are compared with, set by calibrate --compare-with: runs of the jig
   * they branch from. Without it, every baseline run the analysis didn't see. */
  compareWith?: string[];
  /** The results file of the run the analysis diagnosed (analyze --from); the split's own baseline if unset. */
  analyzed?: string;
}

type RunAttempt = Attempt & { attempt: number; steps: number | null };

interface Run {
  file: string;
  attempts: RunAttempt[];
  logs: string;
}

interface Candidate {
  n: number;
  branch: string;
  /** The commit it branched from. */
  base: string;
  /** What the analysis found, which this candidate was asked to fix. */
  cause: string;
  /** What jig said it changed: a line, and a paragraph. */
  subject: string;
  description: string;
  files: string[];
  /** USD: proposing it, and the runs that scored it. */
  spent: number;
  runs: { train?: string; heldOut?: string };
  train?: Comparison;
  heldOut?: Comparison;
  verdict?: Verdict;
  /** What a person decided about it once the referee had accepted it, and why. */
  decision?: string;
  /** Where it was asked to change jig (run --target): only the loop and tools, if "loop". */
  target?: Target;
  /** Terminal-Bench against jig where it branched (tbcheck): the jobs, the comparison and the verdict. */
  terminalBench?: { jobs: { baseline: string[]; candidate: string[] } } & TerminalBenchVerdict;
}

async function main(): Promise<void> {
  const [command, arg] = positionals;
  if (values.help || !command) return console.log(HELP);
  if (command === "split") makeSplit();
  else if (command === "calibrate") calibrate();
  else if (command === "analyze") console.log(await analysis(true));
  else if (command === "propose") await propose(await nextCause());
  else if (command === "score") await score(Number(arg));
  else if (command === "run") await run(Number(values.candidates), Number(values.budget));
  else if (command === "tbcheck") await terminalBench(Number(arg));
  else if (command === "list") list();
  else throw new Error(`Unknown command ${command}.\n\n${HELP}`);
}

/** Splits the suite in two by the latest baseline run's pass rates, so both halves get the hard tasks. */
function makeSplit(): Split {
  const baseline = latestRun("baseline");
  const tasks = [...new Set(baseline.attempts.map((attempt) => attempt.task))];
  const halves = split(tasks, passRates(baseline.attempts), Number(values.seed));
  const result: Split = { seed: Number(values.seed), baseline: relative(ROOT, baseline.file), ...halves, acceptance: { baselines: [], nothing: 0, cheaper25: 0 } };
  console.log(`training: ${halves.train.join(", ")}\nheld out: ${halves.heldOut.join(", ")}`);
  return calibrate(result);
}

/**
 * How often the referee would be fooled, from every baseline run so far (see simulateReferee), saved with
 * the split. Another run of the baseline makes the estimate better: run one, label it baseline-<name>,
 * and calibrate again.
 */
function calibrate(loaded = loadSplit()): Split {
  const named = values["compare-with"]?.split(",").map((label) => label.trim()).filter(Boolean);
  for (const label of named ?? []) {
    // latestRun fails, saying how to make it, if there is none.
    if (relative(ROOT, latestRun(label).file) === analyzedRun(loaded)) throw new Error(`${label} is the run the analysis diagnosed: candidates can't be compared with it.`);
  }
  const current: Split = named ? { ...loaded, compareWith: named } : loaded;
  const runs = baselineRuns(current);
  const pooled = runs.flatMap((run) => run.attempts);
  const comparison = comparisonRuns(current);
  const against = comparison.flatMap((run) => run.attempts);
  const attempts = Number(values.attempts);
  // The baseline a candidate meets is the comparison runs pooled, so the drawn one has as many attempts.
  const baselineAttempts = Math.round(against.length / new Set(against.map((attempt) => attempt.task)).size);
  const simulate = (costScale: number, fixShare = 0, fixed?: Attempt[]) => simulateReferee(pooled, current.train, current.heldOut, { attempts, baselineAttempts, costScale, fixShare, against: fixed });
  const result: Split = {
    ...current,
    acceptance: {
      baselines: runs.map((run) => relative(ROOT, run.file)),
      nothing: simulate(1),
      cheaper25: simulate(0.75),
      fixesThird: simulate(1, 1 / 3),
      against: { runs: comparison.map((run) => relative(ROOT, run.file)), nothing: simulate(1, 0, against), fixesThird: simulate(1, 1 / 3, against) },
    },
  };
  writeFileSync(join(EVOLVE, "split.json"), `${JSON.stringify(result, null, 2)}\n`);
  const { acceptance } = result;
  console.log(`From ${runs.length === 1 ? "the baseline run" : `the ${runs.length} baseline runs`}, the referee would accept a change that does nothing ${pct(acceptance.nothing, 1)} of the time, one that cuts cost by 25% ${pct(acceptance.cheaper25)}, and one that fixes a third of the failures ${pct(acceptance.fixesThird ?? 0)}.`);
  console.log(`Against the ${comparison.length === 1 ? "run" : `${comparison.length} runs`} candidates are compared with (${comparison.map((run) => basename(run.file)).join(", ")}), as ${comparison.length === 1 ? "it" : "they"} came out: ${pct(acceptance.against!.nothing, 1)} and ${pct(acceptance.against!.fixesThird)}.`);
  return result;
}

/**
 * Every run of the baseline on this suite: the one the split and the analysis came from, and the runs
 * labeled baseline-<name> since. Together they say best what each task's pass rate and cost really are.
 */
function baselineRuns(current: Split): Run[] {
  const first = readRun(join(ROOT, current.baseline));
  const suite = JSON.parse(readFileSync(first.file, "utf8")).suite;
  const others = readdirSync(RESULTS)
    .filter((file) => /_baseline-[\w-]+\.json$/.test(file))
    .map((file) => readRun(join(RESULTS, file)))
    .filter((run) => JSON.parse(readFileSync(run.file, "utf8")).suite === suite);
  return [first, ...others];
}

/**
 * The baseline a candidate is compared with: every run the analysis didn't see, pooled, or the first if
 * there is no other. The analysis works from the first run's failures and slow attempts, which another
 * run of the same jig mostly doesn't repeat, so against that run, any change looks better (milestone 14:
 * unchanged jig would have been accepted). Until milestone 16 it was only the latest run, whose luck then
 * became every candidate's: pooling more runs leaves less of it. Once jig itself has changed, its older
 * runs are no longer the jig a candidate branches from, so calibrate --compare-with names the fresh ones.
 */
function comparisonRuns(current: Split): Run[] {
  if (current.compareWith) return current.compareWith.map((label) => latestRun(label));
  const runs = baselineRuns(current);
  const unseen = runs.filter((run) => relative(ROOT, run.file) !== analyzedRun(current));
  return unseen.length ? unseen : runs;
}

/** The run the analysis diagnosed, as a results file relative to the repository. */
function analyzedRun(current: Split): string {
  return current.analyzed ?? current.baseline;
}

function loadSplit(): Split {
  const file = join(EVOLVE, "split.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : makeSplit();
}

/** A results file of bench/run.ts, with the directory of its logs. */
function readRun(file: string): Run {
  const record = JSON.parse(readFileSync(file, "utf8"));
  return { file, attempts: record.attempts, logs: join(ROOT, "bench", "logs", record.id) };
}

function latestRun(label: string): Run {
  const files = existsSync(RESULTS) ? readdirSync(RESULTS).filter((file) => file.endsWith(`_${label}.json`)).sort() : [];
  if (!files.length) throw new Error(`No ${label} run yet. Make one with: node bench/run.ts --suite ${suite} --attempts ${values.attempts} --label ${label}`);
  return readRun(join(RESULTS, files.at(-1)!));
}

const ANALYST = `You study the attempts of a coding agent, jig, at benchmark tasks, to find what in its way of working (its system prompt, its tools, its loop) makes it fail or waste steps. You are precise and brief, and you name causes in terms that would apply to any task of the kind, never in terms of one task, function or test.`;

/**
 * The model's diagnosis of the baseline's training attempts: every failed one, with the hidden tests it
 * failed, and for each task the passing attempt that took the most steps, to see where steps go. Only
 * training tasks: the held-out ones stay unseen until a candidate is judged on them. Saved, since every
 * candidate of a run works from the same analysis.
 */
async function analysis(fresh = false): Promise<string> {
  const file = join(EVOLVE, "analysis.md");
  if (!fresh && existsSync(file)) return readFileSync(file, "utf8");
  const current = loadSplit();
  const { train } = current;
  // Another run's attempts can be diagnosed, of today's jig, say; the analysis then knows its failures, so
  // candidates are compared with other runs (calibrate --compare-with), never with this one.
  const run = values.from ? latestRun(values.from) : readRun(join(ROOT, current.baseline));
  if (values.from && current.compareWith?.includes(values.from)) {
    throw new Error(`${values.from} is one of the runs candidates are compared with: calibrate --compare-with others first.`);
  }
  const baseline = relative(ROOT, run.file);
  const mine = run.attempts.filter((attempt) => train.includes(attempt.task));
  const failed = mine.filter((attempt) => !attempt.passed);
  const longest = train.flatMap((task) => mine.filter((a) => a.task === task && a.passed).sort((a, b) => (b.steps ?? 0) - (a.steps ?? 0)).slice(0, 1));
  const evidence = [...failed, ...longest].map((attempt) => {
    const { instruction } = JSON.parse(readFileSync(join(TASKS, attempt.task, "task.json"), "utf8"));
    const log = readAttemptLog(readFileSync(join(run.logs, `${attempt.task}-${attempt.attempt}.log`), "utf8"));
    return [
      `## ${attempt.passed ? "A passing attempt" : "A failed attempt"} (${attempt.steps} steps, $${(attempt.cost ?? 0).toFixed(4)})`,
      `Task: ${instruction}`,
      `Tool calls, in order:\n${log.toolCalls.map((call) => `- ${call}`).join("\n")}`,
      ...(attempt.passed ? [] : [`Hidden tests that failed:\n${log.failures.join("\n") || "(none listed)"}`]),
      `The agent's last message:\n${log.finalMessage}`,
    ].join("\n\n");
  });
  const limit = JSON.parse(readFileSync(run.file, "utf8")).settings.maxSteps;
  const prompt = `These are attempts by jig at small programming tasks: implementing a written specification, or fixing or changing a small project as an issue asks, after which hidden tests check the work. Each attempt may use at most ${limit} steps (model calls): one that runs out is stopped, and whatever it has written by then is tested. jig solves ${pct(mine.filter((a) => a.passed).length / mine.length)} of them, at $${mean(mine.map((a) => a.cost ?? 0)).toFixed(4)} an attempt.

${evidence.join("\n\n")}

First, one line per attempt: what went wrong, or which steps were wasted. Then a heading "## Causes" and a numbered list of at most four causes, the costliest first, each in one or two sentences saying what jig does and what it should do instead.`;
  const callModel = createModel({ model, system: ANALYST, tools: [], quiet: true });
  const { message } = await callModel([{ role: "user", content: prompt }]);
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  addUsage(usage, message.usage);
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const header = `<!-- The analysis of ${baseline}'s training attempts by ${model}, for $${(costOf(model, usage) ?? 0).toFixed(4)}. What it was shown: bench/${suite}/analysis-prompt.md -->`;
  writeFileSync(join(EVOLVE, "analysis-prompt.md"), `${prompt}\n`);
  writeFileSync(join(EVOLVE, "split.json"), `${JSON.stringify({ ...current, analyzed: baseline }, null, 2)}\n`);
  writeFileSync(file, `${header}\n\n${text.trim()}\n`);
  return readFileSync(file, "utf8");
}

/** The numbered causes under the analysis's "## Causes" heading. */
async function causes(): Promise<string[]> {
  const text = (await analysis()).split(/^#+\s*Causes\s*$/im)[1] ?? "";
  const found = [...text.matchAll(/^\s*\d+\.\s+(.+(?:\n(?!\s*\d+\.)(?!\s*#).+)*)/gm)].map((match) => match[1].replace(/\s+/g, " ").trim());
  if (!found.length) throw new Error(`The analysis lists no causes under a "## Causes" heading (bench/${suite}/analysis.md).`);
  return found;
}

/** Where a round's changes may go: anywhere in jig, or only its loop and tools, leaving the system prompt alone. */
type Target = "any" | "loop";

const WHERE: Record<Target, string> = {
  any: "most likely in its system prompt (src/prompt.ts), but it could be in a tool's description or behaviour (src/tools/) or in its loop (src/agent.ts)",
  loop: "in its loop (src/agent.ts) or its tools (src/tools/), not in its system prompt (src/prompt.ts): nine changes to the prompt were measured on these tasks, and none held up",
};

const IMPROVE = (cause: string, earlier: string, failing: string[], limit: number, target: Target) => `You are improving jig, the coding agent whose source code is in this repository (src/). On a benchmark of small programming tasks (specifications to implement, issues to fix), checked by hidden tests, with at most ${limit} steps (model calls) for each task, an analysis of jig's attempts found this:

${cause}

Make one change to jig that addresses it: ${WHERE[target]}. The change will be measured on tasks you will never see, for the share solved and the cost: one that makes jig slower or more expensive without solving more will be rejected.
- Change only files under src/ or skills/.
- Keep the change general, so it would help with any task of this kind: don't name a particular task, function, file or test.
- Keep it small and in the style of the code around it. In a prompt, fewer words are better: every word goes into every request.
- Check it with \`${TESTS}\`.${failing.length ? ` Your commands run in a sandbox, where ${failing.length === 1 ? "this test fails" : `these ${failing.length} tests fail`} before any change, because ${failing.length === 1 ? "it starts" : "they start"} a sandbox of ${failing.length === 1 ? "its" : "their"} own or run ps, which it doesn't allow: ${failing.map((name) => `"${name}"`).join(", ")}. What counts is that your change adds no failures; the whole suite runs again outside the sandbox before the change is measured.` : ""}
- Don't commit. When you are done, reply with a line starting "Summary:" that says what the change does in under ten words, then a paragraph: what you changed and why it should help.${earlier ? `\n\nEarlier candidates, and how they did:\n${earlier}` : ""}`;

/**
 * The next candidate: the main checkout's jig changes a copy of itself, and the change is committed on a
 * new branch. The copy is HEAD's files without the benchmarks or the evaluation, in a repository of its
 * own, so that git's history can't reach the hidden tests either (the analysis found jig looking there).
 * jig runs with its sandbox on, with a home directory of its own (outside the copy and the temp
 * directories, as in bench/run.ts, so that the sandbox tests can run), and so without the user's
 * settings, skills or memory.
 */
async function propose(cause: string): Promise<Candidate> {
  const n = nextNumber();
  const branch = `${suite}/${n}`;
  const base = git("rev-parse", "--short", "HEAD");
  const logs = join(LOGS, String(n));
  mkdirSync(logs, { recursive: true });
  // Outside bench/, which the candidate's sandbox hides from it, with the tasks and their answers.
  const home = join(HOMES, `${suite}-${n}`);
  mkdirSync(home, { recursive: true });
  hideAnswers(join(home, ".jig"));
  const tree = workspace(ROOT, base);
  try {
    const failing = sandboxedFailures(tree, home);
    console.log(`\ncandidate ${n}: ${cause}`);
    const stats = join(logs, "stats.json");
    const args = ["--yes", "--model", model, "--max-steps", "60", "--stats", stats, "--add-dir", home, "-"];
    const limit = JSON.parse(readFileSync(join(ROOT, loadSplit().baseline), "utf8")).settings.maxSteps;
    const transcript = await jig(args, { cwd: tree, home, stdin: IMPROVE(cause, earlier(), failing, limit, target()), timeout: 1500 });
    writeFileSync(join(logs, "propose.log"), transcript);
    const usage = existsSync(stats) ? (JSON.parse(readFileSync(stats, "utf8")).usage as Usage) : undefined;
    const { subject, description } = replySummary(transcript);
    const files = changedFiles(tree);
    let diff = "";
    if (files.length) {
      commitPatch(ROOT, branch, base, patchOf(tree), [`evolve ${n}: ${subject}`, description]);
      diff = git("diff", `${base}..${branch}`);
    }
    const candidate: Candidate = { n, branch, base, cause, subject, description, files, spent: usage ? (costOf(model, usage) ?? 0) : 0, runs: {}, ...(target() !== "any" && { target: target() }) };
    save(candidate, diff);
    console.log(`candidate ${n}: ${subject || "(no summary)"}: changed ${files.join(", ") || "nothing"} ($${candidate.spent.toFixed(3)})`);
    return candidate;
  } finally {
    rmSync(dirname(tree), { recursive: true, force: true });
  }
}

/**
 * The tests that fail in a candidate's sandbox before it has changed anything: those that start a sandbox
 * of their own or run ps, which the sandbox doesn't allow. Run as jig would run the command, so the
 * candidate can be told which failures aren't its doing.
 */
function sandboxedFailures(tree: string, home: string): string[] {
  const sandbox = createSandbox(tree, { network: false, dirs: [home] });
  if (!sandbox) return [];
  const { program, args } = sandbox.wrap(TESTS);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/_API_KEY$|_AUTH_TOKEN$/.test(name)));
  return failingTests(spawnSync(program, args, { cwd: tree, env: { ...env, HOME: home }, encoding: "utf8", timeout: 300_000 }).stdout ?? "");
}

/** The referee. Everything it runs comes from the main checkout; only src/ and skills/ come from the branch. */
async function score(n: number): Promise<Candidate> {
  const candidate = archived().find((c) => c.n === n);
  if (!candidate) throw new Error(`No candidate ${n} in ${relative(ROOT, ARCHIVE)}.`);
  const current = loadSplit();
  const { train, heldOut } = current;
  const bases = comparisonRuns(current);
  if (bases.some((run) => relative(ROOT, run.file) === analyzedRun(current))) {
    throw new Error(`Candidates would be compared with ${analyzedRun(current)}, the run the analysis diagnosed: calibrate --compare-with other runs first.`);
  }
  const base = bases.flatMap((run) => run.attempts);
  console.log(`candidate ${n}: compared with ${bases.map((run) => relative(ROOT, run.file)).join(" and ")}`);
  const limit = (run: Run) => JSON.parse(readFileSync(run.file, "utf8")).settings.maxSteps;
  const limits = new Set(bases.map(limit));
  if (limits.size > 1 || !limits.has(suiteLimit())) throw new Error(`The baseline runs had a step limit of ${[...limits].join(" and ")}, and the suite's is now ${suiteLimit()}: run the baseline again first.`);
  const decide = (verdict: Verdict) => {
    candidate.verdict = verdict;
    save(candidate);
    console.log(`candidate ${n}: ${verdict.stage}: ${verdict.reason}`);
    if (verdict.stage === "rejected" && branchExists(candidate.branch)) git("branch", "-D", "-q", candidate.branch);
    if (verdict.stage === "accepted") console.log(`candidate ${n}: next, Terminal-Bench: npm run evolve -- tbcheck ${n}`);
    return candidate;
  };
  if (!candidate.files.length) return decide({ stage: "rejected", reason: "it changed nothing" });
  const forbidden = forbiddenFiles(candidate.files);
  if (forbidden.length) return decide({ stage: "rejected", reason: `it changed files outside src/ and skills/: ${forbidden.join(", ")}` });
  if (candidate.target === "loop" && candidate.files.includes("src/prompt.ts")) return decide({ stage: "rejected", reason: "it changed the system prompt, which its round left alone" });
  const leaked = leakedWords(readFileSync(join(ARCHIVE, String(n), "change.diff"), "utf8"), taskWords(TASKS));
  if (leaked.length) return decide({ stage: "rejected", reason: `it names the tasks: ${leaked.join(", ")}` });
  console.log(`candidate ${n}: running jig's tests`);
  if (!testsPass(candidate)) return decide({ stage: "rejected", reason: "jig's tests fail with it" });

  const trainRun = await bench(candidate, train, "train");
  if (!limits.has(limit(trainRun))) throw new Error(`The baseline ran with a step limit of ${[...limits].join(" and ")} and the candidate with ${limit(trainRun)}: they can't be compared.`);
  candidate.runs.train = relative(ROOT, trainRun.file);
  candidate.train = compare(trainRun.attempts, base.filter((a) => train.includes(a.task)));
  candidate.spent += sum(trainRun.attempts);
  const first = judgeTrain(candidate.train);
  if (first.stage === "rejected") return decide(first);
  console.log(`candidate ${n}: ${first.reason}; now the held-out tasks`);
  const heldOutRun = await bench(candidate, heldOut, "heldout");
  candidate.runs.heldOut = relative(ROOT, heldOutRun.file);
  candidate.heldOut = compare(heldOutRun.attempts, base.filter((a) => heldOut.includes(a.task)));
  candidate.spent += sum(heldOutRun.attempts);
  return decide(judgeHeldOut(candidate.heldOut));
}

/** jig's tests, as of the commit the candidate branched from, against the candidate's src/ and skills/. */
function testsPass(candidate: Candidate): boolean {
  const tree = join(mkdtempSync(join(tmpdir(), "jig-evolve-test-")), "jig");
  git("worktree", "add", "-q", "--detach", tree, candidate.branch);
  try {
    execFileSync("git", ["checkout", candidate.base, "--", "test"], { cwd: tree, stdio: "ignore" });
    symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
    execFileSync("npm", ["test"], { cwd: tree, stdio: "ignore", timeout: 600_000 });
    return true;
  } catch {
    return false;
  } finally {
    git("worktree", "remove", "--force", tree);
  }
}

/** The step limit bench/run.ts gives this suite's attempts: its suite.json's, or the runner's default. */
function suiteLimit(): number {
  const config = join(EVOLVE, "suite.json");
  return existsSync(config) ? (JSON.parse(readFileSync(config, "utf8")).max_steps ?? 40) : 40;
}

/** The candidate's branch on some of the tasks, run by the main checkout's runner. */
async function bench(candidate: Candidate, tasks: string[], stage: string): Promise<Run> {
  const label = `evolve-${candidate.n}-${stage}`;
  const args = [join(ROOT, "bench", "run.ts"), "--suite", suite, "--ref", candidate.branch, "--tasks", tasks.join(","), "--attempts", values.attempts, "--model", model, "--label", label];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`bench/run.ts exited with ${code}`))));
  });
  return latestRun(label);
}

/**
 * The first cause no candidate has worked on yet with this --target, or once every one has, the causes
 * again in turn: a cause tried in the prompt is still new to a round that may only change the loop.
 */
async function nextCause(): Promise<string> {
  const found = await causes();
  const tried = archived().filter((c) => (c.target ?? "any") === target()).map((c) => c.cause);
  return found.find((cause) => !tried.includes(cause)) ?? found[tried.length % found.length];
}

/** Proposes and scores candidates, a cause each, until there are enough or the budget is spent. */
async function run(count: number, budget: number): Promise<void> {
  let spent = 0;
  for (let i = 0; i < count && spent < budget; i++) {
    const candidate = await propose(await nextCause());
    spent += (await score(candidate.n)).spent;
    console.log(`spent so far: $${spent.toFixed(3)} of $${budget.toFixed(2)}`);
  }
  list();
}

function list(): void {
  const share = (comparison?: Comparison) => (comparison ? `${pct(comparison.candidate)} vs ${pct(comparison.baseline)}, cost ×${comparison.costRatio?.toFixed(2) ?? "?"}` : "-");
  if (!archived().length) console.log(`No candidates on ${suite} yet: npm run evolve -- run --suite ${suite} makes them.`);
  for (const c of archived()) {
    console.log(`\n#${c.n} ${c.verdict?.stage ?? "not scored"}  ($${c.spent.toFixed(3)})  ${c.branch}${branchExists(c.branch) ? "" : " (deleted)"}`);
    console.log(`  cause:    ${c.cause.slice(0, 160)}`);
    console.log(`  change:   ${c.subject}`);
    console.log(`  training: ${share(c.train)}   held out: ${share(c.heldOut)}`);
    if (c.verdict) console.log(`  verdict:  ${c.verdict.reason}`);
    if (c.terminalBench) console.log(`  terminal-bench: ${c.terminalBench.rejected ? "rejected" : "passed"}: ${c.terminalBench.reason}`);
    if (c.decision) console.log(`  decision: ${c.decision}`);
  }
}

/** The --target given, checked. */
function target(): Target {
  if (values.target !== "any" && values.target !== "loop") throw new Error("--target must be any or loop");
  return values.target;
}

/** Minutes a Terminal-Bench round may take per task: milestone 17's longest was under 8; peak hours wait. */
const TB_MINUTES_PER_TASK = 10.5;

/**
 * Terminal-Bench for a candidate the referee accepted: it and jig where it branched, on the tasks in
 * eval/subset.txt (or --tb-tasks), alternating as milestone 17 did by hand, so that whatever DeepSeek's
 * service does over the hours falls on both. Each round starts only when it can finish outside the peak
 * hours. Rounds already run are kept, so after a break the command picks up where it stopped.
 */
async function terminalBench(n: number): Promise<void> {
  const candidate = archived().find((c) => c.n === n);
  if (!candidate) throw new Error(`No candidate ${n} in ${relative(ROOT, ARCHIVE)}.`);
  if (candidate.verdict?.stage !== "accepted") throw new Error(`Candidate ${n} wasn't accepted by the referee: only accepted candidates go to Terminal-Bench.`);
  // A person's decision can delete the branch; the archive keeps the change, and the branch goes again after.
  const rebuilt = !branchExists(candidate.branch);
  if (rebuilt) {
    const diff = readFileSync(join(ARCHIVE, String(n), "change.diff"), "utf8");
    commitPatch(ROOT, candidate.branch, candidate.base, diff.endsWith("\n") ? diff : `${diff}\n`, [`evolve ${n}: ${candidate.subject}`, "Rebuilt from the archive for Terminal-Bench."]);
    console.log(`candidate ${n}: rebuilt ${candidate.branch} from its archived change`);
  }
  try {
    await checkOnTerminalBench(candidate);
  } finally {
    if (rebuilt) git("branch", "-D", "-q", candidate.branch);
  }
}

async function checkOnTerminalBench(candidate: Candidate): Promise<void> {
  const { n } = candidate;
  const smoke = values["tb-tasks"] !== undefined;
  const tasks = smoke ? values["tb-tasks"]!.split(",") : readFileSync(join(ROOT, "eval", "subset.txt"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  pullImages(tasks);
  const jobs: { baseline: string[]; candidate: string[] } = { baseline: [], candidate: [] };
  for (const { side, round } of runOrder(Number(values.rounds))) {
    const job = `tb-${suite}-${n}-${side}-r${round}${smoke ? "-smoke" : ""}`;
    jobs[side].push(job);
    if (trialsDone(job) >= tasks.length) {
      console.log(`${job}: already run`);
      continue;
    }
    const start = nextStart(new Date(), (tasks.length * TB_MINUTES_PER_TASK) / 60);
    if (start.getTime() > Date.now()) {
      console.log(`${job}: waiting until ${start.toLocaleString()}, to stay out of DeepSeek's peak hours`);
      await new Promise((done) => setTimeout(done, start.getTime() - Date.now()));
    }
    const balance = await deepseekBalance();
    if (balance !== null && balance < MIN_BALANCE_CNY) throw new Error(`${job}: DeepSeek's balance is ${balance} CNY, under ${MIN_BALANCE_CNY}: top it up, then run tbcheck again to go on.`);
    console.log(`${job}: running jig at ${side === "baseline" ? candidate.base : candidate.branch} on ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
    await terminalBenchJob(job, side === "baseline" ? candidate.base : candidate.branch, tasks);
    const refused = refusedTrials(job);
    if (refused.length) {
      for (const trial of refused) rmSync(join(ROOT, "eval", "jobs", job, trial), { recursive: true, force: true });
      throw new Error(`${job}: the API refused ${refused.length} trial${refused.length === 1 ? "" : "s"} (out of balance?), removed to run again: fix that, then run tbcheck again to go on.`);
    }
  }
  // Every trial, as eval/report.py counts them (a look-up of the benchmark's answers fails), kept with the candidate.
  const out = join(ARCHIVE, String(n), smoke ? "terminal-bench-smoke" : "terminal-bench");
  const runs = (["baseline", "candidate"] as const).map((side) => join("eval", "jobs", jobs[side].join("+")));
  execFileSync("python3", ["eval/report.py", "--save", out, ...runs], { cwd: ROOT, stdio: "inherit" });
  const load = (side: "baseline" | "candidate") => attemptsOf(JSON.parse(readFileSync(join(out, `${jobs[side][0]}.json`), "utf8")).trials);
  const verdict = terminalBenchVerdict(load("candidate"), load("baseline"));
  console.log(`candidate ${n}: ${verdict.reason}`);
  if (smoke) {
    console.log("A smoke test on some of the tasks: its verdict isn't recorded.");
    return;
  }
  candidate.terminalBench = { jobs, ...verdict };
  save(candidate);
  console.log(`The task images stay in Docker (about 28 GB for all twenty tasks).`);
}

/** The task images, pulled before a round rather than during it, where a slow download fails the setup. */
function pullImages(tasks: string[]): void {
  for (const task of tasks) {
    const image = `alexgshaw/${task}:20251031`;
    if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0) continue;
    console.log(`pulling ${image}`);
    for (let attempt = 1; spawnSync("docker", ["pull", "-q", "--platform", "linux/amd64", image], { stdio: "ignore" }).status !== 0; attempt++) {
      if (attempt === 3) throw new Error(`Couldn't pull ${image}: is Docker running?`);
    }
  }
}

/** The trials of a job that the API refused (see refusedByApi). */
function refusedTrials(job: string): string[] {
  const dir = join(ROOT, "eval", "jobs", job);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((trial) => {
    const result = join(dir, trial, "result.json");
    if (!existsSync(result)) return false;
    const transcript = join(dir, trial, "agent", "jig.txt");
    const exception = (JSON.parse(readFileSync(result, "utf8")).exception_info ?? {}).exception_type;
    return refusedByApi(existsSync(transcript) ? readFileSync(transcript, "utf8") : "", exception);
  });
}

function trialsDone(job: string): number {
  const dir = join(ROOT, "eval", "jobs", job);
  return existsSync(dir) ? readdirSync(dir).filter((trial) => existsSync(join(dir, trial, "result.json"))).length : 0;
}

/** One round, through eval/run.sh, or Harbor's resume for a round a break cut short. */
function terminalBenchJob(job: string, ref: string, tasks: string[]): Promise<void> {
  mkdirSync(LOGS, { recursive: true });
  const log = join(LOGS, `terminal-bench-${job}.log`);
  const resume = existsSync(join(ROOT, "eval", "jobs", job, "config.json"));
  const [program, args] = resume ? [join(ROOT, "eval", ".venv", "bin", "harbor"), ["job", "resume", "-p", join("eval", "jobs", job)]] : [join(ROOT, "eval", "run.sh"), [job, "jig", "--ak", `ref=${ref}`]];
  return new Promise((resolve, reject) => {
    const out = openSync(log, "a");
    const child = spawn(program, args, { cwd: ROOT, env: { ...process.env, TASKS: tasks.join(" "), PYTHONPATH: join(ROOT, "eval") }, stdio: ["ignore", out, out] });
    child.on("close", (code) => {
      closeSync(out);
      if (trialsDone(job) >= tasks.length) resolve();
      else reject(new Error(`${job} stopped after ${trialsDone(job)} of ${tasks.length} trials (exit ${code}); see ${relative(ROOT, log)}, and run tbcheck again to go on.`));
    });
  });
}

/** Earlier candidates and their verdicts, for the next one to learn from. */
function earlier(): string {
  // What happened after the referee too: an accepted change that Terminal-Bench or a person turned down
  // isn't one to repeat (milestone 16's was copied by the two candidates after it).
  const after = (c: Candidate) =>
    [c.terminalBench && ` Then on Terminal-Bench: ${c.terminalBench.reason}.`, c.decision && ` Decision: ${c.decision}.`].filter(Boolean).join("");
  return archived()
    .map((c) => `- ${(c.subject || "(no summary)").replace(/\.$/, "")}. ${c.verdict ? `Verdict: ${c.verdict.stage}, ${c.verdict.reason}.` : "Not scored."}${after(c)}`)
    .join("\n");
}

function archived(): Candidate[] {
  if (!existsSync(ARCHIVE)) return [];
  return readdirSync(ARCHIVE)
    .filter((name) => existsSync(join(ARCHIVE, name, "candidate.json")))
    .map((name) => JSON.parse(readFileSync(join(ARCHIVE, name, "candidate.json"), "utf8")) as Candidate)
    .sort((a, b) => a.n - b.n);
}

/** One more than any candidate archived or branched, so a run that broke off never reuses a number. */
function nextNumber(): number {
  const branches = git("branch", "--list", `${suite}/*`, "--format=%(refname:short)").split("\n").filter(Boolean);
  const used = [...archived().map((c) => c.n), ...branches.map((branch) => Number(branch.slice(suite.length + 1)))];
  return Math.max(0, ...used.filter(Number.isInteger)) + 1;
}

function save(candidate: Candidate, diff?: string): void {
  const dir = join(ARCHIVE, String(candidate.n));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
  if (diff !== undefined) writeFileSync(join(dir, "change.diff"), diff);
}

function branchExists(branch: string): boolean {
  return git("branch", "--list", branch) !== "";
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The main checkout's jig, on a task given on stdin; returns what it printed. */
function jig(args: string[], { cwd, home, stdin, timeout }: { cwd: string; home: string; stdin: string; timeout: number }): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME: home, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGINT"), timeout * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(output);
    });
    child.stdin.end(stdin);
  });
}

function sum(attempts: Attempt[]): number {
  return attempts.reduce((total, attempt) => total + (attempt.cost ?? 0), 0);
}

function mean(numbers: number[]): number {
  return numbers.length ? numbers.reduce((total, x) => total + x, 0) / numbers.length : 0;
}

function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
