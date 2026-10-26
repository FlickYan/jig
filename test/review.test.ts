import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { constants } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTurn } from "../src/model.ts";
import { problemsOf, recheck, reviewer, reviewPrompt, runningReviewPrompt, sentBackWithEvidence, verdictOf, workLog } from "../src/review.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { SubagentSetup } from "../src/tools/subagent.ts";
import { fakeMessagesApi, type Reply, runJig } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

afterEach(removeTempDirs);

type MessageParam = Anthropic.Beta.BetaMessageParam;

const call = (id: string, name: string, input: object): MessageParam => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (id: string, content: string, is_error = false): MessageParam => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] });

describe("a review's verdict", () => {
  it("is read from the reply's first APPROVED or PROBLEMS line", () => {
    assert.deepEqual(verdictOf("APPROVED: every requirement is met."), { verdict: "approved" });
    assert.deepEqual(verdictOf("**PROBLEMS:**\n- out.txt is missing\n- the date is in the wrong format"), { verdict: "problems", problems: "- out.txt is missing\n- the date is in the wrong format" });
    assert.deepEqual(verdictOf("I read the files.\n\nPROBLEMS:\n1. No test for empty input."), { verdict: "problems", problems: "1. No test for empty input." });
    assert.deepEqual(verdictOf("**Verdict: PROBLEMS**\n1. No test for empty input."), { verdict: "problems", problems: "1. No test for empty input." });
    assert.deepEqual(verdictOf("Problems I looked for: none.\nApproved by the tests."), { verdict: "none" }, "only the words in capitals");
    assert.deepEqual(verdictOf("The work looks fine to me."), { verdict: "none" }, "no verdict: nothing is sent back");
    assert.deepEqual(verdictOf("PROBLEMS:"), { verdict: "none" });
  });

  it("is approved when the PROBLEMS line says there are none", () => {
    assert.deepEqual(verdictOf("PROBLEMS: None."), { verdict: "approved" });
    assert.deepEqual(verdictOf("**PROBLEMS:**\n- No problems found."), { verdict: "approved" });
    const checklist = "Requirement 1: out.txt exists - ok\nRequirement 2: it holds the total - ok\nPROBLEMS: none found\n\nAPPROVED";
    assert.deepEqual(verdictOf(checklist), { verdict: "approved" });
    assert.deepEqual(problemsOf("PROBLEMS: N/A"), [], "nothing for `jig review` to re-check");
    // Only a first line that says nothing else: one that goes on names a problem.
    assert.deepEqual(verdictOf("PROBLEMS: x fails"), { verdict: "problems", problems: "x fails" });
    assert.deepEqual(verdictOf("PROBLEMS: None of the tests pass."), { verdict: "problems", problems: "None of the tests pass." });
  });

  it("takes a later APPROVED or PROBLEMS line after one that says there are none", () => {
    assert.deepEqual(verdictOf("PROBLEMS: No issues found.\n\nAPPROVED"), { verdict: "approved" });
    const checklist = "Requirement 1: out.txt exists - ok\nRequirement 2: it holds the total - ok\nPROBLEMS: None - all requirements are met.\n\nAPPROVED";
    assert.deepEqual(verdictOf(checklist), { verdict: "approved" });
    const perRequirement = "1. out.txt exists\nPROBLEMS: none\n2. it holds the total\nPROBLEMS: x fails";
    assert.deepEqual(verdictOf(perRequirement), { verdict: "problems", problems: "x fails" });
  });
});

describe("the work log a reviewer gets", () => {
  it("lists file changes and commands with how they ended, and leaves out reads", () => {
    const log = workLog([
      { role: "user", content: "Write the report." },
      call("a", "read_file", { path: "spec.md" }),
      result("a", "1\tthe spec"),
      call("b", "write_file", { path: "report.py" }),
      result("b", "Wrote report.py"),
      call("c", "edit_file", { path: "main.py" }),
      result("c", "old_string not found", true),
      call("d", "bash", { command: "python report.py\n  --check" }),
      result("d", "Traceback ...\nValueError: bad date\n\nExit code: 1"),
    ]);
    assert.equal(log, "write_file report.py\nedit_file main.py (failed)\n$ python report.py ⏎ --check\n  → exit 1, last line: ValueError: bad date");
  });

  it("keeps the most recent entries of a long run", () => {
    const messages = Array.from({ length: 100 }, (_, i) => [call(`c${i}`, "bash", { command: `step ${i}` }), result(`c${i}`, "ok\n\nExit code: 0")]).flat();
    const log = workLog(messages);
    assert.match(log, /^\(20 earlier entries left out\)\n\$ step 20\n/);
    assert.match(log, /\$ step 99\n {2}→ exit 0, last line: ok$/);
  });

  it("goes in the prompt with the task and the model's last message", () => {
    const prompt = reviewPrompt("Write out.txt.", "Done: out.txt written.", "write_file out.txt");
    assert.match(prompt, /<task>\nWrite out.txt.\n<\/task>/);
    assert.match(prompt, /<the agent's last message>\nDone: out.txt written.\n/);
    assert.match(prompt, /write_file out.txt\n<\/what the agent did>$/);
    assert.match(prompt, /Start your reply with APPROVED .* or with PROBLEMS:/);
  });
});

describe("the reviewer", () => {
  const turn = (text: string, stop: Anthropic.Beta.BetaStopReason = "end_turn"): ModelTurn => ({
    message: { content: [{ type: "text", text, citations: null }], stop_reason: stop, usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage,
    malformed: new Map(),
  });
  const setupWith = async (replies: ModelTurn[], seen: MessageParam[][]): Promise<SubagentSetup> => ({
    callModel: async (messages) => (seen.push(messages), replies.shift()!),
    tools: TOOLS.filter((tool) => tool.kind === "read"),
    cwd: await tempDir("jig-review-"),
    maxSteps: 4,
    compactAt: 0,
    authorize: async () => null,
    ui: () => ({ toolCall() {}, toolResult() {}, notice() {} }),
  });
  const look = (id: string): ModelTurn => ({
    message: { content: [{ type: "tool_use", id, name: "glob", input: { pattern: "*" } }], stop_reason: "tool_use", usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage,
    malformed: new Map(),
  });
  const work = { task: "Write out.txt.", answer: "Done.", messages: [{ role: "user", content: "Write out.txt." }] as MessageParam[] };

  it("runs a loop of its own on the review, and words the problems for the model", async () => {
    const seen: MessageParam[][] = [];
    const review = await reviewer("strong", await setupWith([turn("PROBLEMS:\n- out.txt is missing")], seen)).review(work);
    assert.equal(review.verdict, "problems");
    assert.match(review.feedback!, /^A reviewer, another model, checked your work against the task and reported these problems:\n\n- out\.txt is missing\n\nIt can be wrong/);
    assert.deepEqual(review.usage, { input: 40, cacheWrite: 0, cacheRead: 0, output: 4 });
    assert.match(String(seen[0][0].content), /^Another agent was given the task below/);
  });

  it("is asked for its verdict when it runs out of steps", async () => {
    const seen: MessageParam[][] = [];
    const setup = await setupWith([look("a"), look("b"), look("c"), look("d"), turn("PROBLEMS:\n- out.txt is missing")], seen);
    const review = await reviewer("strong", setup).review(work);
    assert.equal(review.verdict, "problems");
    assert.match(JSON.stringify(seen.at(-1)!.at(-1)), /You have run out of steps/);
    assert.equal(review.usage.input, 200, "the four steps and the verdict");
  });

  it("is asked for its verdict when it is stopped for repeating itself", async () => {
    const seen: MessageParam[][] = [];
    const setup = await setupWith([look("a"), look("b"), look("c"), look("d"), look("e"), turn("APPROVED")], seen);
    const review = await reviewer("strong", { ...setup, maxSteps: 10 }).review(work);
    assert.equal(review.verdict, "approved");
    assert.equal(seen.length, 6, "five steps, then the request for its verdict");
    assert.match(JSON.stringify(seen.at(-1)!.at(-1)), /You have run out of steps/);
  });

  it("is asked for its verdict when it replies twice with nothing, and told only that", async () => {
    const seen: MessageParam[][] = [];
    const silent = (): ModelTurn => ({ message: { ...turn("").message, content: [] }, malformed: new Map() });
    const setup = await setupWith([look("a"), silent(), silent(), turn("PROBLEMS:\n- out.txt is missing")], seen);
    const review = await reviewer("strong", setup).review(work);
    assert.equal(review.verdict, "problems");
    assert.equal(seen.length, 4, "three steps, then the request for its verdict");
    // The loop's note after the first empty reply asked it to go on: the request takes its place.
    const request = JSON.stringify(seen.at(-1));
    assert.match(request, /tool_result.*Two of your replies were empty\. Don't call any more tools: give your verdict now/);
    assert.doesNotMatch(request, /continue the task|run out of steps/);
    // The first cut off at the output limit while still thinking: its own note gives way too.
    const cut: MessageParam[][] = [];
    const thinking: ModelTurn = { message: { ...turn("", "max_tokens").message, content: [{ type: "thinking", thinking: "Every requirement", signature: "sig" }] }, malformed: new Map() };
    await reviewer("strong", await setupWith([look("a"), thinking, silent(), turn("APPROVED")], cut)).review(work);
    assert.match(JSON.stringify(cut.at(-1)), /tool_result.*Two of your replies were empty\. Don't call any more tools: give your verdict now/);
    assert.doesNotMatch(JSON.stringify(cut.at(-1)), /continue the task/);
  });

  it("sends nothing back when it approves or stays cut off, and finishes a verdict that was cut off", async () => {
    const approves = await reviewer("strong", await setupWith([turn("APPROVED")], [])).review(work);
    assert.deepEqual([approves.verdict, approves.feedback], ["approved", undefined]);
    const cutOff = (text: string) => turn(text, "max_tokens");
    const cut = await reviewer("strong", await setupWith([cutOff("PROBLEMS:\n- out.txt is miss"), cutOff("ing\n- the"), cutOff(" date")], [])).review(work);
    assert.deepEqual([cut.verdict, cut.feedback], ["none", undefined]);
    const finished = await reviewer("strong", await setupWith([cutOff("PROBLEMS:\n- out.txt is miss"), turn("ing")], [])).review(work);
    assert.equal(finished.verdict, "problems");
    assert.match(finished.feedback!, /:\n\n- out\.txt is missing\n\nIt can be wrong/);
  });
});

describe("a review that runs the work", () => {
  const block = (what: string, command: string, shows: string) => `<problem>\n<what>${what}</what>\n<command>${command}</command>\n<shows>${shows}</shows>\n</problem>`;

  it("reads each problem with its command and what it showed, a fenced command as it would run", () => {
    const text = `PROBLEMS:\n${block("the total must be 42", "python3 total.py", "41")}\n${block("no header row", "```bash\nhead -1 out.csv\n```", "1,2,3")}`;
    assert.deepEqual(problemsOf(text), [
      { what: "the total must be 42", command: "python3 total.py", shows: "41" },
      { what: "no header row", command: "head -1 out.csv", shows: "1,2,3" },
    ]);
    assert.deepEqual(problemsOf("PROBLEMS:\n- out.txt is missing"), [{ what: "- out.txt is missing" }], "without blocks: one problem, no evidence");
    // As flash wrote one in milestone 29's smoke test: no </what>.
    const unclosed = "PROBLEMS:\n<problem>\n<what>the 5th is MTEB\n<command>python3 rank.py</command>\n<shows>5 MTEB</shows>\n</problem>";
    assert.deepEqual(problemsOf(unclosed), [{ what: "the 5th is MTEB", command: "python3 rank.py", shows: "5 MTEB" }], "a tag left open ends at the next");
    assert.deepEqual(problemsOf("<problem>\nthe 5th is MTEB\n<command>python3 rank.py</command>\n</problem>"), [{ what: "the 5th is MTEB", command: "python3 rank.py", shows: undefined }]);
  });

  it("keeps a problem only if its command, run again, prints what it showed", async () => {
    const run = async (command: string) => (command === "count" ? "rows:\n  41\n\nExit code: 0" : "");
    assert.equal((await recheck({ what: "x", command: "count", shows: "rows: 41" }, run)).held, true, "across lines and indentation");
    assert.equal((await recheck({ what: "x", command: "count", shows: "rows: 42" }, run)).held, false);
    assert.deepEqual(await recheck({ what: "x" }, run), { held: false }, "no command: nothing to run");
  });

  it("sends the problems back with their evidence", () => {
    const message = sentBackWithEvidence([{ what: "the total must be 42", command: "python3 total.py", shows: "41" }, { what: "no README" }]);
    assert.match(message, /^A reviewer, another model, ran your work in a copy of this machine/);
    assert.match(message, /1\. the total must be 42\n {3}It ran:\n {6}python3 total\.py\n {3}and got:\n {6}41\n\n2\. no README\n\nIt can be wrong/);
  });

  it("is asked to show each problem with a command that works in a fresh copy", () => {
    const prompt = runningReviewPrompt({ task: "Write out.txt.", answer: "Done.", log: "write_file out.txt", changes: "A /app/out.txt" }, { minutes: 4, steps: 20, rechecked: true });
    assert.match(prompt, /^Another agent was given the task below, worked on it, and now says it is done\. Check that by running the work/);
    assert.match(prompt, /about 4 minutes and 20 replies/);
    assert.match(prompt, /run again in a fresh copy of the work/);
    assert.match(prompt, /<the files that differ from the machine the agent started on: A added, C changed, D deleted>\nA \/app\/out\.txt\n/);
  });
});

describe("jig review", () => {
  /** A session in which the agent wrote out.txt and said it was done; `compacted` before saying so. */
  async function session(dir: string, compacted = false): Promise<string> {
    const path = join(dir, "agent.jsonl");
    const summary = { role: "user", content: "The conversation so far was compacted to save context. This is its summary:\n\nI wrote out.txt and checked it." };
    const entries = [
      { type: "start", cwd: "/app", model: "deepseek-flash", date: "2026-10-14T00:00:00Z" },
      { type: "message", message: { role: "user", content: "Write out.txt with the total, 42." } },
      { type: "message", message: call("w", "write_file", { path: "out.txt", content: "41" }) },
      { type: "message", message: result("w", "Wrote out.txt") },
      ...(compacted ? [{ type: "compaction", messages: [summary] }] : []),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done: out.txt holds the total." }] } },
    ];
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    return path;
  }

  /** The reviewer's replies: a command first, then its verdict, or one reply after another. */
  const replies = (verdicts: string | string[]) => {
    const queue = [verdicts].flat();
    return (request: Record<string, unknown>) =>
      (request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "printf 'total: 41\\n'" } }] : [{ text: queue.length > 1 ? queue.shift()! : queue[0] }];
  };

  async function review(verdict: string | string[] | ((request: Record<string, unknown>) => Reply), extra: string[] = [], compacted = false) {
    const dir = await tempDir("jig-review-cli-");
    const api = await fakeMessagesApi(typeof verdict === "function" ? verdict : replies(verdict));
    try {
      const args = ["review", "--session", await session(dir, compacted), "--exec", "bash -c", "--verify-exec", "bash -c", "--model", "claude-haiku-4-5", "--time-limit", "150", "--out", join(dir, "verdict.json"), ...extra];
      const { code, output } = await runJig(args, { api, cwd: dir });
      assert.equal(code, 0, output);
      return { verdict: JSON.parse(await readFile(join(dir, "verdict.json"), "utf8")), requests: api.requests };
    } finally {
      api.close();
    }
  }

  it("runs the reviewer's commands through --exec, and keeps a problem whose command shows it in a fresh copy", async () => {
    const { verdict, requests } = await review(`PROBLEMS:\n<problem><what>out.txt holds 41, not 42</what><command>printf 'total: 41\\n'</command><shows>total: 41</shows></problem>`);
    assert.deepEqual((requests[0].tools as { name: string }[]).map((tool) => tool.name), ["bash"]);
    assert.match(JSON.stringify(requests[0].messages), /Write out.txt with the total, 42\..*Done: out.txt holds the total\..*write_file out.txt/);
    assert.match(JSON.stringify(requests[1].messages), /total: 41\\n\\nExit code: 0/, "the command ran, and the reviewer saw its output");
    assert.equal(verdict.verdict, "problems");
    assert.deepEqual([verdict.problems[0].held, verdict.problems[0].output], [true, "total: 41\n\nExit code: 0"]);
    assert.match(verdict.feedback, /1\. out\.txt holds 41, not 42\n {3}It ran:\n {6}printf 'total: 41\\n'\n/);
    assert.equal(verdict.stop, "end_turn");
  });

  it("takes the task and what the agent did from the whole session, not from a compaction's summary", async () => {
    // After a compaction the conversation starts from the agent's own summary: the reviewer got its claims as
    // the task, and only what it did after them.
    const { requests } = await review("APPROVED", [], true);
    const prompt = JSON.stringify(requests[0].messages);
    assert.match(prompt, /<task>\\nWrite out\.txt with the total, 42\.\\n<\/task>.*write_file out\.txt/);
    assert.doesNotMatch(prompt, /This is its summary/);
  });

  it("drops a problem whose command doesn't show it again, and then sends nothing back", async () => {
    const { verdict } = await review(`PROBLEMS:\n<problem><what>out.txt is empty</what><command>printf 'total: 41\\n'</command><shows>total: 0</shows></problem>`);
    assert.deepEqual([verdict.verdict, verdict.problems[0].held, verdict.feedback], ["problems", false, null]);
  });

  it("asks for the verdict when the steps run out, at low effort, with the form of a problem", async () => {
    const { verdict, requests } = await review("APPROVED", ["--max-steps", "1"]);
    assert.equal(verdict.verdict, "approved");
    assert.equal(verdict.stop, "max_steps");
    assert.match(JSON.stringify(requests.at(-1)!.messages), /You have run out of steps: no more commands will run\..*starting with APPROVED, or with PROBLEMS: and each problem as a <problem> with its <what>, <command> and <shows>/);
    assert.deepEqual(requests.at(-1)!.tool_choice, { type: "none" });
    assert.deepEqual([requests[0].output_config, requests.at(-1)!.output_config], [{ effort: "medium" }, { effort: "low" }]);
  });

  it("asks for the verdict, as when the steps run out, when the reviewer is stopped for repeating itself", async () => {
    // The same command every step, until it is asked for its verdict (the request that allows no tool).
    const again = (request: Record<string, unknown>): Reply => (request.tool_choice ? [{ text: "APPROVED" }] : [{ tool: "bash", input: { command: "printf 'total: 41\\n'" } }]);
    const { verdict, requests } = await review(again);
    assert.deepEqual([verdict.verdict, verdict.stop, verdict.steps, requests.length], ["approved", "loop", 5, 6]);
    assert.match(JSON.stringify(requests.at(-1)!.messages), /You have run out of steps: no more commands will run\./);
  });

  it("asks for the verdict, as when the steps run out, when the reviewer replies twice with nothing, and says only that", async () => {
    // A command, then empty replies, until it is asked for its verdict (the request that allows no tool).
    const empty = (request: Record<string, unknown>): Reply =>
      request.tool_choice ? [{ text: "APPROVED" }] : (request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "printf 'total: 41\\n'" } }] : [];
    const { verdict, requests } = await review(empty);
    assert.deepEqual([verdict.verdict, verdict.stop, verdict.steps, requests.length], ["approved", "empty", 3, 4]);
    // The loop's note after the first empty reply asked it to go on: the request takes its place.
    const request = JSON.stringify(requests.at(-1)!.messages);
    assert.match(request, /Two of your replies were empty: no more commands will run\. Give your verdict now, on what you have checked/);
    assert.doesNotMatch(request, /continue the task|run out of steps/);
  });

  it("answers a verdict request's reply that has no verdict once, as when a model writes a tool call out as text", async () => {
    const call = '<｜DSML｜function_calls><｜DSML｜invoke name="bash">ls</｜DSML｜invoke></｜DSML｜function_calls>';
    const { verdict, requests } = await review([call, "APPROVED"], ["--max-steps", "1"]);
    assert.equal(verdict.verdict, "approved");
    assert.equal(requests.length, 3, "the loop's one step, and the verdict asked for twice");
    assert.match(JSON.stringify(requests[2].messages), /DSML.*That reply has no verdict, and no tool runs now/);
  });

  it("leaves an empty reply to the verdict request out of the next request, which the API would reject", async () => {
    // A command, then empty replies, the first to the verdict request too.
    let asks = 0;
    const empty = (request: Record<string, unknown>): Reply =>
      request.tool_choice ? (asks++ === 0 ? [] : [{ text: "APPROVED" }]) : (request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "printf 'total: 41\\n'" } }] : [];
    const { verdict, requests } = await review(empty);
    assert.deepEqual([verdict.verdict, verdict.stop, requests.length], ["approved", "empty", 5]);
    const sent = requests.flatMap((request) => request.messages as MessageParam[]);
    assert.ok(sent.every((message) => message.role === "user" || message.content.length > 0), "no assistant message without content");
    assert.match(JSON.stringify(requests.at(-1)!.messages), /Two of your replies were empty: no more commands.*Your last reply was empty, and no tool runs now\./);
  });

  it("asks only twice when no verdict comes", async () => {
    const { verdict, requests } = await review("I will check one more thing.", ["--max-steps", "1"]);
    assert.deepEqual([verdict.verdict, requests.length], ["none", 3]);
  });

  it("leaves nothing in the temp directory, when the review fails too", async () => {
    // An API that turns every request down, as once the credit has run out. The directory jig review makes
    // in the temp directory for its own bookkeeping was removed only when the review ended well.
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low." } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    const dir = await tempDir("jig-review-cli-");
    const temp = await tempDir("jig-review-tmp-"); // jig's temp directory, of its own
    try {
      const args = ["review", "--session", await session(dir), "--exec", "bash -c", "--model", "claude-haiku-4-5", "--out", join(dir, "verdict.json")];
      const { code, output } = await runJig(args, { api, cwd: dir, env: { TMPDIR: temp } });
      assert.equal(code, 1, output);
      assert.match(output, /Your credit balance is too low/);
      assert.deepEqual((await readdir(temp)).filter((name) => name.startsWith("jig-")), []);
    } finally {
      api.close();
    }
  });

  it("leaves nothing in the temp directory when a signal ends it, and exits with the code a shell would give", async () => {
    // The API hangs, and the review is stopped as a harness stops one that runs over time, as closing its
    // terminal does, or with Ctrl+C. A signal ends jig without the exit event, which removes the directory.
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
      let pid = 0;
      const server = createServer((req) => {
        req.resume();
        process.kill(pid, signal); // and never answers
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const dir = await tempDir("jig-review-cli-");
      const temp = await tempDir("jig-review-tmp-"); // jig's temp directory, of its own
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const env = { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: await tempDir("jig-home-"), TMPDIR: temp };
        const args = ["review", "--session", await session(dir), "--exec", "bash -c", "--model", "claude-haiku-4-5", "--out", join(dir, "verdict.json")];
        const child = spawn(process.execPath, [cli, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
        pid = child.pid!;
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        const code = await new Promise<number | null>((done) => child.on("close", done));
        assert.equal(code, 128 + constants.signals[signal], `${signal}: ${output}`);
        assert.deepEqual((await readdir(temp)).filter((name) => name.startsWith("jig-")), [], `${signal} left jig's directory behind`);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }
  });
});
