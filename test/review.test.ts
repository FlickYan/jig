import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTurn } from "../src/model.ts";
import { reviewer, reviewPrompt, verdictOf, workLog } from "../src/review.ts";
import { TOOLS } from "../src/tools/index.ts";
import type { SubagentSetup } from "../src/tools/subagent.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;

const call = (id: string, name: string, input: object): MessageParam => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (id: string, content: string, is_error = false): MessageParam => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] });

describe("a review's verdict", () => {
  it("is read from the reply's first APPROVED or PROBLEMS line", () => {
    assert.deepEqual(verdictOf("APPROVED: every requirement is met."), { verdict: "approved" });
    assert.deepEqual(verdictOf("**PROBLEMS:**\n- out.txt is missing\n- the date is in the wrong format"), { verdict: "problems", problems: "- out.txt is missing\n- the date is in the wrong format" });
    assert.deepEqual(verdictOf("I read the files.\n\nPROBLEMS:\n1. No test for empty input."), { verdict: "problems", problems: "1. No test for empty input." });
    assert.deepEqual(verdictOf("The work looks fine to me."), { verdict: "none" }, "no verdict: nothing is sent back");
    assert.deepEqual(verdictOf("PROBLEMS:"), { verdict: "none" });
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
    cwd: await mkdtemp(join(tmpdir(), "jig-review-")),
    maxSteps: 4,
    compactAt: 0,
    authorize: async () => null,
    ui: () => ({ toolCall() {}, toolResult() {}, notice() {} }),
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
    const look = (id: string): ModelTurn => ({
      message: { content: [{ type: "tool_use", id, name: "glob", input: { pattern: "*" } }], stop_reason: "tool_use", usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage,
      malformed: new Map(),
    });
    const setup = await setupWith([look("a"), look("b"), look("c"), look("d"), turn("PROBLEMS:\n- out.txt is missing")], seen);
    const review = await reviewer("strong", setup).review(work);
    assert.equal(review.verdict, "problems");
    assert.match(JSON.stringify(seen.at(-1)!.at(-1)), /You have run out of steps/);
    assert.equal(review.usage.input, 200, "the four steps and the verdict");
  });

  it("sends nothing back when it approves or is cut off", async () => {
    const approves = await reviewer("strong", await setupWith([turn("APPROVED")], [])).review(work);
    assert.deepEqual([approves.verdict, approves.feedback], ["approved", undefined]);
    const cut = await reviewer("strong", await setupWith([turn("PROBLEMS:\n- out.txt is miss", "max_tokens")], [])).review(work);
    assert.deepEqual([cut.verdict, cut.feedback], ["none", undefined]);
  });
});
