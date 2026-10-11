// The referee of `bench/evolve.ts`: the rules a candidate change to jig must pass before anyone is asked
// to merge it. They are pure functions over a diff and benchmark results, kept apart from the loop so the
// tests can check them, and kept out of the candidate's reach: the loop runs them from the main checkout,
// whatever the candidate's branch contains.

/** What a candidate may change: jig's code, prompts and tools, and its own skills. Never the benchmark, its
 * tasks, the tests that guard jig, or the evaluation. */
export const ALLOWED = [/^src\//, /^skills\//];

/** The files of a diff (`git diff --name-only`) that a candidate may not touch. */
export function forbiddenFiles(files: string[]): string[] {
  return files.filter((file) => !ALLOWED.some((pattern) => pattern.test(file)));
}

/**
 * Words that tie a change to the tasks it was made from: task names, and the names the tasks define (their
 * functions, modules, flags). A candidate that mentions them is fitted to the exam, not improving jig.
 * Only words of five or more characters count, so ordinary words in code don't trip it.
 */
export function leakedWords(diff: string, taskWords: string[]): string[] {
  const added = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n")
    .toLowerCase();
  return [...new Set(taskWords.map((word) => word.toLowerCase()).filter((word) => word.length >= 5 && new RegExp(`\\b${escape(word)}\\b`).test(added)))];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One benchmark attempt, as bench/run.ts records it. */
export interface Attempt {
  task: string;
  passed: boolean;
  cost?: number | null;
}

/** Each task's attempts, passed or not. */
function byTask(attempts: Attempt[]): Map<string, boolean[]> {
  const tasks = new Map<string, boolean[]>();
  for (const attempt of attempts) tasks.set(attempt.task, [...(tasks.get(attempt.task) ?? []), attempt.passed]);
  return tasks;
}

function rate(results: boolean[]): number {
  return results.filter(Boolean).length / results.length;
}

/** Each task's share of passed attempts. */
export function passRates(attempts: Attempt[]): Map<string, number> {
  return new Map([...byTask(attempts)].map(([task, results]) => [task, rate(results)]));
}

/** The candidate against the baseline, paired by task: the mean difference and a bootstrap interval. */
export interface Comparison {
  tasks: number;
  candidate: number;
  baseline: number;
  difference: number;
  low: number;
  high: number;
  /** The share of resamples in which the candidate came out ahead. */
  ahead: number;
  costRatio?: number;
}

/**
 * Compares two runs on the tasks both attempted. Each resample draws tasks (attempts at one task aren't
 * independent, so tasks are the unit, as in the Terminal-Bench report), and then each drawn task's
 * attempts, for both runs: with three attempts a task, one lucky attempt is a third of its pass rate, and
 * that noise belongs in the interval too. Seeded, so the same runs always give the same answer.
 */
export function compare(candidate: Attempt[], baseline: Attempt[], resamples = 10_000, seed = 1): Comparison {
  const a = byTask(candidate);
  const b = byTask(baseline);
  const tasks = [...a.keys()].filter((task) => b.has(task)).sort();
  const diffs = tasks.map((task) => rate(a.get(task)!) - rate(b.get(task)!));
  const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const redraw = (results: boolean[]) => rate(results.map(() => pick(results)));
  const resample = () => mean(tasks.map(() => pick(tasks)).map((task) => redraw(a.get(task)!) - redraw(b.get(task)!)));
  const means = Array.from({ length: resamples }, resample).sort((x, y) => x - y);
  const cost = (attempts: Attempt[]) => mean(attempts.filter((t) => tasks.includes(t.task) && t.cost != null).map((t) => t.cost!));
  const baseCost = cost(baseline);
  return {
    tasks: tasks.length,
    candidate: mean(tasks.map((task) => rate(a.get(task)!))),
    baseline: mean(tasks.map((task) => rate(b.get(task)!))),
    difference: mean(diffs),
    low: means[Math.floor(0.025 * resamples)] ?? 0,
    high: means[Math.ceil(0.975 * resamples) - 1] ?? 0,
    ahead: tasks.length ? means.filter((m) => m > 0).length / resamples : 0,
    ...(baseCost > 0 && { costRatio: cost(candidate) / baseCost }),
  };
}

export type Verdict = { stage: "rejected" | "train" | "accepted"; reason: string };

/**
 * Whether a candidate goes on, and then whether it is kept: on the training tasks (whose attempts it was
 * made from), and then on the held-out ones, which it was never shown, it must solve more than the
 * baseline in at least 80% of resamples, or as many for at least 15% less. Until milestone 14's results,
 * solving more on the held-out tasks meant any more, one attempt in fifteen; rerunning the baseline showed
 * that unchanged jig would have been accepted that way (see simulateReferee). Even so, with ten tasks an
 * accepted candidate is a lead for a person to review, not proof, which is why nothing here merges it.
 */
export function judgeTrain(train: Comparison): Verdict {
  if (train.difference > ZERO && train.ahead >= 0.8) return { stage: "train", reason: `solved more of the training tasks (${sign(train.difference)}, ahead in ${pct(train.ahead)} of resamples)` };
  if (train.difference >= -ZERO && cheaper(train)) return { stage: "train", reason: `solved as many training tasks for ${pct(1 - train.costRatio!)} less` };
  return { stage: "rejected", reason: `no better on the training tasks (${sign(train.difference)}, ahead in ${pct(train.ahead)} of resamples${train.costRatio ? `, cost ×${train.costRatio.toFixed(2)}` : ""})` };
}

export function judgeHeldOut(heldOut: Comparison): Verdict {
  if (heldOut.difference > ZERO && heldOut.ahead >= 0.8) return { stage: "accepted", reason: `solved more held-out tasks too (${sign(heldOut.difference)}, ahead in ${pct(heldOut.ahead)} of resamples)` };
  if (heldOut.difference >= -ZERO && cheaper(heldOut)) return { stage: "accepted", reason: `as many held-out tasks for ${pct(1 - heldOut.costRatio!)} less` };
  return { stage: "rejected", reason: `didn't carry over to the held-out tasks (${sign(heldOut.difference)}, ahead in ${pct(heldOut.ahead)} of resamples${heldOut.costRatio ? `, cost ×${heldOut.costRatio.toFixed(2)}` : ""})` };
}

/** Pass rates are means of thirds, so "no difference" can come out as 1e-17. */
const ZERO = 1e-9;

function cheaper(comparison: Comparison): boolean {
  return comparison.costRatio !== undefined && comparison.costRatio <= 0.85;
}

/**
 * How often the referee accepts a candidate whose effect is known. Each trial draws a candidate's runs and
 * a baseline's from what the baseline runs given show of each task: its pass rate (shrunk toward the
 * overall rate, as 3/3 doesn't mean always) and its costs, the candidate's times costScale. At costScale 1
 * the candidate changes nothing, and the share is the referee's false acceptance rate: what an "accepted"
 * is worth. With fixShare, the candidate also turns that share of the baseline's failures into passes
 * (each task's pass rate p becomes p + fixShare × (1 − p)): how often a real improvement is accepted.
 * Both runs have `attempts` attempts a task, as a candidate and a baseline run do. The baseline is drawn
 * too because it is a sample as well: milestone 14 first held it fixed, which made the rate look ten
 * times smaller than a second run of the baseline showed it to be.
 */
export function simulateReferee(baselines: Attempt[], train: string[], heldOut: string[], { costScale = 1, fixShare = 0, attempts = 3, trials = 1000, seed = 1 } = {}): number {
  const overall = rate(baselines.map((attempt) => attempt.passed));
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const truth = new Map(
    [...new Set(baselines.map((attempt) => attempt.task))].map((task) => {
      const mine = baselines.filter((attempt) => attempt.task === task);
      const costs = mine.flatMap((attempt) => (attempt.cost == null ? [] : [attempt.cost]));
      return [task, { p: (mine.filter((attempt) => attempt.passed).length + overall) / (mine.length + 1), costs }];
    }),
  );
  const draw = (tasks: string[], scale: number, fix: number, count: number): Attempt[] =>
    tasks.flatMap((task) => {
      const { p, costs } = truth.get(task) ?? { p: overall, costs: [] };
      const rate = p + fix * (1 - p);
      return Array.from({ length: count }, () => ({ task, passed: random() < rate, cost: costs.length ? costs[Math.floor(random() * costs.length)] * scale : null }));
    });
  const stage = (tasks: string[]) => compare(draw(tasks, costScale, fixShare, attempts), draw(tasks, 1, 0, attempts), 400, state);
  let accepted = 0;
  for (let trial = 1; trial <= trials; trial++) {
    if (judgeTrain(stage(train)).stage === "rejected") continue;
    if (judgeHeldOut(stage(heldOut)).stage === "accepted") accepted++;
  }
  return accepted / trials;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function sign(value: number): string {
  return `${value > 0 ? "+" : ""}${Math.round(value * 100)} points`;
}

/**
 * Splits tasks into training and held-out halves, the same way every time for the same seed. With the
 * pass rates of a calibration run, tasks are sorted by them first and dealt out alternately, so both
 * halves get a share of the hard tasks.
 */
export function split(tasks: string[], rates: Map<string, number>, seed: number): { train: string[]; heldOut: string[] } {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const shuffled = [...tasks].sort().map((task) => ({ task, key: random() }));
  shuffled.sort((x, y) => (rates.get(x.task) ?? 0) - (rates.get(y.task) ?? 0) || x.key - y.key);
  const train: string[] = [];
  const heldOut: string[] = [];
  const first = random() < 0.5 ? 0 : 1;
  shuffled.forEach(({ task }, index) => (index % 2 === first ? train : heldOut).push(task));
  return { train: train.sort(), heldOut: heldOut.sort() };
}
