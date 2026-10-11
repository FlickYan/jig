import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { failingTests, readAttemptLog, replySummary, taskWords } from "../bench/evolve-analysis.ts";
import { changedFiles, commitPatch, patchOf, workspace } from "../bench/evolve-workspace.ts";
import { type Attempt, compare, forbiddenFiles, judgeHeldOut, judgeTrain, leakedWords, passRates, simulateReferee, split } from "../bench/evolve-referee.ts";

/** Attempts with the given passes out of three per task, each costing `cost`. */
function runOf(passes: Record<string, number>, cost = 0.01): Attempt[] {
  return Object.entries(passes).flatMap(([task, passed]) => [0, 1, 2].map((i) => ({ task, passed: i < passed, cost })));
}

const FIVE = { a: 3, b: 3, c: 3, d: 3, e: 3 };

describe("the evolve referee", () => {
  it("lets a candidate change only jig's code and skills", () => {
    assert.deepEqual(forbiddenFiles(["src/prompt.ts", "skills/x/SKILL.md", "src/tools/bash.ts"]), []);
    assert.deepEqual(forbiddenFiles(["src/prompt.ts", "bench/evolve-referee.ts", "test/agent.test.ts", "package.json", "bench/evolve/tasks/a/tests/test_hidden.py"]), [
      "bench/evolve-referee.ts",
      "test/agent.test.ts",
      "package.json",
      "bench/evolve/tasks/a/tests/test_hidden.py",
    ]);
  });

  it("finds task words a change adds, but not ones it removes or short ones", () => {
    const diff = ["--- a/src/prompt.ts", "+++ b/src/prompt.ts", "-old line naming parse_duration", "+- Check Money-Format rules and edge cases.", "+- Read the spec (SPEC) again."].join("\n");
    assert.deepEqual(leakedWords(diff, ["parse_duration", "money-format", "spec", "cron-next"]), ["money-format"]);
    assert.deepEqual(leakedWords("+formatting money is hard", ["money-format", "format_money"]), []);
  });

  it("compares runs task by task", () => {
    const same = compare(runOf(FIVE), runOf(FIVE));
    assert.equal(same.difference, 0);
    assert.equal(same.ahead, 0);
    assert.equal(same.costRatio, 1);
    const better = compare(runOf(FIVE, 0.008), runOf({ ...FIVE, a: 1, b: 1 }));
    assert.equal(better.tasks, 5);
    assert.ok(Math.abs(better.difference - 4 / 15) < 1e-9);
    assert.ok(better.low >= 0 && better.high > better.difference);
    assert.ok(Math.abs(better.costRatio! - 0.8) < 1e-9);
    assert.deepEqual(compare(runOf(FIVE), runOf({ ...FIVE, a: 2 }), 2000, 7), compare(runOf(FIVE), runOf({ ...FIVE, a: 2 }), 2000, 7), "seeded");
    assert.equal(compare(runOf({ a: 3, z: 0 }), runOf({ a: 2 })).tasks, 1, "only tasks both runs attempted");
  });

  it("counts the noise of each task's three attempts, not only which tasks were drawn", () => {
    // One lucky attempt on one task of five is no evidence, and neither is fixing one task outright.
    assert.equal(judgeTrain(compare(runOf(FIVE), runOf({ ...FIVE, a: 2 }))).stage, "rejected");
    assert.equal(judgeTrain(compare(runOf(FIVE), runOf({ ...FIVE, a: 0 }))).stage, "rejected");
    assert.equal(judgeTrain(compare(runOf(FIVE), runOf({ ...FIVE, a: 1, b: 1 }))).stage, "train");
  });

  it("passes a candidate that solves as many for clearly less, but not one that solves fewer", () => {
    assert.match(judgeTrain(compare(runOf(FIVE, 0.008), runOf(FIVE, 0.01))).reason, /as many training tasks for 20% less/);
    assert.equal(judgeTrain(compare(runOf(FIVE, 0.009), runOf(FIVE, 0.01))).stage, "rejected", "10% isn't clearly less");
    assert.equal(judgeTrain(compare(runOf({ ...FIVE, a: 2 }, 0.005), runOf(FIVE, 0.01))).stage, "rejected");
    assert.equal(judgeHeldOut(compare(runOf({ ...FIVE, a: 2 }, 0.005), runOf(FIVE, 0.01))).stage, "rejected");
    assert.equal(judgeHeldOut(compare(runOf(FIVE, 0.008), runOf(FIVE, 0.01))).stage, "accepted");
    assert.equal(judgeHeldOut(compare(runOf(FIVE), runOf(FIVE))).stage, "rejected");
  });

  it("asks as much of the held-out tasks as of the training ones", () => {
    // One more attempt in fifteen was enough until a second run of the baseline, unchanged, did it.
    assert.equal(judgeHeldOut(compare(runOf(FIVE), runOf({ ...FIVE, c: 2 }))).stage, "rejected");
    assert.match(judgeHeldOut(compare(runOf(FIVE), runOf({ ...FIVE, a: 1, b: 1 }))).reason, /^solved more held-out tasks too \(\+27 points, ahead in 9\d% of resamples\)$/);
  });

  it("treats differences of thirds that cancel out as no difference", () => {
    // (0 - 0) + (0 - 1/3) + (1 - 2/3) comes to 1.9e-17, which isn't solving more.
    const mixed = compare(runOf({ a: 0, b: 0, c: 3 }), runOf({ a: 0, b: 1, c: 2 }));
    assert.ok(mixed.difference > 0 && mixed.difference < 1e-12);
    assert.equal(judgeHeldOut(mixed).stage, "rejected");
  });

  it("splits tasks the same way every time, with hard tasks on both sides", () => {
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const rates = new Map(tasks.map((task) => [task, task === "t3" || task === "t6" ? 1 / 3 : 1]));
    const { train, heldOut } = split(tasks, rates, 14);
    assert.deepEqual(split(tasks, rates, 14), { train, heldOut });
    assert.equal(train.length, 4);
    assert.deepEqual([...train, ...heldOut].sort(), tasks);
    assert.equal(train.filter((task) => rates.get(task)! < 1).length, 1);
    assert.notDeepEqual(split(tasks, rates, 15).train, train, "another seed, another split (for these tasks)");
  });

  it("rarely accepts a change that does nothing, and often one that is much cheaper", () => {
    const baseline = runOf({ a: 3, b: 2, c: 3, d: 3, e: 3, f: 3, g: 3, h: 2, i: 3, j: 3 }).map((attempt, i) => ({ ...attempt, cost: 0.01 + (i % 3) * 0.002 }));
    const train = ["a", "b", "c", "d", "e"];
    const heldOut = ["f", "g", "h", "i", "j"];
    const nothing = simulateReferee(baseline, train, heldOut, { trials: 300 });
    const cheaper = simulateReferee(baseline, train, heldOut, { costScale: 0.7, trials: 300 });
    assert.ok(nothing < 0.02 && cheaper > 0.4, `${nothing}, ${cheaper}`);
    // Seeded: the same baseline gives the same estimate.
    assert.equal(simulateReferee(baseline, train, heldOut, { costScale: 0.7, trials: 300 }), cheaper);
  });

  it("accepts a change that fixes failures more often the more it fixes", () => {
    const halfway = runOf({ a: 1, b: 2, c: 1, d: 2, e: 1, f: 2, g: 1, h: 2, i: 1, j: 2 });
    const train = ["a", "b", "c", "d", "e"];
    const heldOut = ["f", "g", "h", "i", "j"];
    const rates = [0, 1 / 3, 2 / 3].map((fixShare) => simulateReferee(halfway, train, heldOut, { fixShare, trials: 300 }));
    assert.ok(rates[0] < 0.05 && rates[0] < rates[1] && rates[1] < rates[2], rates.join(", "));
  });

  it("gives each task its share of passed attempts", () => {
    assert.deepEqual(passRates(runOf({ a: 3, b: 1 })), new Map([["a", 1], ["b", 1 / 3]]));
  });
});

describe("reading attempts", () => {
  const log = `
$ jig: Implement parse in config.py so that it follows SPEC.md.

I'll read the spec first.
● read_file SPEC.md
  ⎿ read_file SPEC.md
       1	# parse
● bash python -m unittest -q
  OK
Implemented every rule.

Verification: the visible tests pass.
9 steps · 0 tool errors · 31.2k tokens · $0.0120

--- changes ---
 M config.py
+def parse(text):

--- check ---
FAIL: test_negative (bench_tests.test_hidden.Test.test_negative)
Traceback (most recent call last):
AssertionError: '($5.00)' != '-$5.00'
Ran 4 tests in 0.001s
FAILED (failures=1)

--- FAILED ---
`;

  it("finds the failed hidden tests, the tool calls and the agent's last words", () => {
    const attempt = readAttemptLog(log);
    assert.deepEqual(attempt.failures, ["FAIL: test_negative (bench_tests.test_hidden.Test.test_negative)", "AssertionError: '($5.00)' != '-$5.00'"]);
    assert.deepEqual(attempt.toolCalls, ["read_file SPEC.md", "bash python -m unittest -q"]);
    assert.match(attempt.finalMessage, /Implemented every rule\.\n\nVerification: the visible tests pass\.$/);
    assert.doesNotMatch(attempt.finalMessage, /steps ·/);
  });

  it("reads a transcript without the benchmark's sections, as jig prints it", () => {
    const attempt = readAttemptLog("● edit_file src/prompt.ts\nI shortened the prompt.\n3 steps · 0 tool errors · $0.0100\n");
    assert.deepEqual(attempt.toolCalls, ["edit_file src/prompt.ts"]);
    assert.deepEqual(attempt.failures, []);
    assert.match(attempt.finalMessage, /I shortened the prompt\.$/);
  });

  it("collects the words that would tie a change to the tasks", async () => {
    const tasks = await mkdtemp(join(tmpdir(), "jig-evolve-words-"));
    await mkdir(join(tasks, "retry-limit", "repo", "pkg"), { recursive: true });
    await writeFile(join(tasks, "retry-limit", "task.json"), JSON.stringify({ instruction: "Add a --max-retries flag, also read from APP_MAX_RETRIES." }));
    await writeFile(join(tasks, "retry-limit", "repo", "pkg", "client.py"), "def load_settings(path):\n    pass\n\ndef run():\n    pass\n");
    await writeFile(join(tasks, "retry-limit", "repo", "pkg", "__init__.py"), "");
    await writeFile(join(tasks, "retry-limit", "repo", "SPEC.md"), "def not_python(x):\n");
    await writeFile(join(tasks, "retry-limit", "repo", ".env.example"), "");
    await mkdir(join(tasks, "not-a-task"));
    assert.deepEqual(taskWords(tasks), ["--max-retries", "APP_MAX_RETRIES", "SPEC.md", "client.py", "load_settings", "retry-limit"]);
  });
});

describe("a candidate's workspace", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "jig-evolve-repo-"));
    for (const [file, text] of Object.entries({
      "src/prompt.ts": "export const PROMPT = 1;\n",
      "bench/run.ts": "// the runner\n",
      "bench/evolve/tasks/a/tests/test_hidden.py": "assert True\n",
      "bench/tasks/b/solution/fix.py": "pass\n",
      "eval/report.py": "pass\n",
      "test/a.test.ts": "// a test\n",
    })) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), text);
    }
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first");
    git(root, "commit", "-q", "--allow-empty", "-m", "second");
    return root;
  }

  it("leaves out the benchmarks and the evaluation, and the history that holds them", async () => {
    const root = await repository();
    const tree = workspace(root, "HEAD");
    assert.ok(existsSync(join(tree, "src/prompt.ts")) && existsSync(join(tree, "bench/run.ts")) && existsSync(join(tree, "test/a.test.ts")));
    assert.ok(!existsSync(join(tree, "bench/evolve")) && !existsSync(join(tree, "bench/tasks")) && !existsSync(join(tree, "eval")));
    assert.equal(git(tree, "rev-list", "--all", "--count"), "1");
    assert.equal(git(tree, "log", "--all", "--format=%B").includes("second"), false);
    assert.deepEqual(changedFiles(tree), []);
  });

  it("brings the change back as a branch, leaving the checkout as it was", async () => {
    const root = await repository();
    await writeFile(join(root, "test/a.test.ts"), "// edited in the checkout, not committed\n");
    const tree = workspace(root, "HEAD");
    await writeFile(join(tree, "src/prompt.ts"), "export const PROMPT = 2;\n");
    await writeFile(join(tree, "src/new.ts"), "export {};\n");
    assert.deepEqual(changedFiles(tree).sort(), ["src/new.ts", "src/prompt.ts"]);
    commitPatch(root, "evolve/1", "HEAD", patchOf(tree), ["evolve 1: a change", "Why it helps."]);
    assert.deepEqual(git(root, "diff", "--name-only", "HEAD", "evolve/1").split("\n"), ["src/new.ts", "src/prompt.ts"]);
    assert.equal(git(root, "show", "evolve/1:src/prompt.ts"), "export const PROMPT = 2;");
    assert.equal(git(root, "log", "-1", "--format=%s%n%b", "evolve/1"), "evolve 1: a change\nWhy it helps.");
    assert.equal(git(root, "branch", "--show-current"), "main");
    assert.equal(git(root, "status", "--porcelain"), "M test/a.test.ts");
    assert.equal(readFileSync(join(root, "src/prompt.ts"), "utf8"), "export const PROMPT = 1;\n");
  });

  it("reads the summary line and paragraph of the reply", () => {
    const reply = (text: string) => `● edit_file src/prompt.ts\n${text}\n12 steps · 0 tool errors · $0.0300\n`;
    assert.deepEqual(replySummary(reply("Done.\n\n**Summary:** Check every stated rule\n\nI added a sentence. It helps.")), { subject: "Check every stated rule", description: "I added a sentence. It helps." });
    assert.deepEqual(replySummary(reply("Summary: Shorter prompt\nI cut two lines.")), { subject: "Shorter prompt", description: "I cut two lines." });
    assert.deepEqual(replySummary(reply("Some notes.\n\nI changed the loop. It now stops sooner.")), { subject: "I changed the loop.", description: "I changed the loop. It now stops sooner." });
  });

  it("lists the failed tests of a run", () => {
    const output = "▶ sandbox\n  ✖ keeps commands off the network (55.8ms)\n✖ sandbox (180.9ms)\nℹ fail 2\n\n✖ failing tests:\n\ntest at test/safety.test.ts:48:3\n✖ keeps commands off the network (55.8ms)\n  Error: denied\n\ntest at test/headless.test.ts:90:3\n✖ reads the task from stdin when it is - (319.7ms)\n";
    assert.deepEqual(failingTests(output), ["keeps commands off the network", "reads the task from stdin when it is -"]);
    assert.deepEqual(failingTests("ℹ pass 3\nℹ fail 0\n"), []);
  });
});
