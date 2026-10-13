import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { failedTestRun, runAgent, type AgentOptions, type Reviewer, type ReviewVerdict } from "../src/agent.ts";
import { Conversation } from "../src/conversation.ts";
import type { ModelTurn } from "../src/model.ts";
import { TOOLS } from "../src/tools/index.ts";

type Block = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;

function reply(content: Block[], stopReason?: Anthropic.Beta.BetaStopReason, malformed = new Map<string, string>()): ModelTurn {
  const stop_reason = stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg", type: "message", role: "assistant", model: "fake", content, stop_reason, usage };
  return { message: message as Anthropic.Beta.BetaMessage, malformed };
}

/** Test setup: a fake model that plays back scripted replies and records how long the history was at each call. */
function setup(replies: ModelTurn[], overrides: Partial<AgentOptions> = {}) {
  const historyLengths: number[] = [];
  const options: AgentOptions = {
    callModel: async (messages) => {
      historyLengths.push(messages.length);
      const next = replies.shift();
      if (!next) throw new Error("the fake model ran out of replies");
      return next;
    },
    tools: TOOLS,
    cwd,
    maxSteps: 10,
    compactAt: 0,
    authorize: async () => null,
    ui: { toolCall() {}, toolResult() {}, notice() {} },
    ...overrides,
  };
  const conversation = new Conversation(undefined, [{ role: "user", content: "do the task" }]);
  return { options, conversation, messages: conversation.messages, historyLengths };
}

function resultsIn(message: MessageParam): ToolResult[] {
  return message.content as ToolResult[];
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "jig-agent-"));
});

describe("checking the work before finishing (one-shot runs)", () => {
  const REVIEW = "Check your work.";

  it("asks once when the model first stops, and lets it carry on", async () => {
    const { options, conversation, messages } = setup(
      [reply([text("Done.")]), reply([toolUse("t1", "bash", { command: "echo checked" })]), reply([text("Verified: it prints checked.")])],
      { review: REVIEW },
    );
    const result = await runAgent(conversation, options);
    assert.equal(result.stop, "end_turn");
    assert.equal(result.steps, 3);
    assert.equal(result.text, "Verified: it prints checked.");
    assert.deepEqual(messages[2], { role: "user", content: REVIEW }, "the check comes right after the first stop");
  });

  it("asks only once, and not at all without the option", async () => {
    const twice = setup([reply([text("Done.")]), reply([text("Still done.")])], { review: REVIEW });
    assert.equal((await runAgent(twice.conversation, twice.options)).text, "Still done.");
    const never = setup([reply([text("Done.")])]);
    const result = await runAgent(never.conversation, never.options);
    assert.deepEqual([result.steps, result.text], [1, "Done."]);
  });
});

describe("runAgent", () => {
  it("runs tools and feeds the results back until the model answers", async () => {
    const { options, conversation, messages, historyLengths } = setup([
      reply([text("Creating it."), toolUse("t1", "write_file", { path: "hello.txt", content: "hi\n" })]),
      reply([toolUse("t2", "edit_file", { path: "hello.txt", old_string: "hi", new_string: "hello" })]),
      reply([text("Done.")]),
    ]);
    const result = await runAgent(conversation, options);

    assert.equal(result.stop, "end_turn");
    assert.equal(result.text, "Done.");
    assert.equal(result.steps, 3);
    assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello\n");
    // The history only grows: user, then an assistant/user pair per tool round, then the answer.
    assert.deepEqual(historyLengths, [1, 3, 5]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    const [first] = resultsIn(messages[2]);
    assert.equal(first.tool_use_id, "t1");
    assert.equal(first.is_error, undefined);
    assert.equal(result.usage.input, 300);
  });

  it("answers every call of a parallel reply in a single message", async () => {
    const { options, conversation, messages } = setup([
      reply([toolUse("a", "bash", { command: "echo one" }), toolUse("b", "bash", { command: "echo two" })]),
      reply([text("ok")]),
    ]);
    await runAgent(conversation, options);
    assert.deepEqual(resultsIn(messages[2]).map((r) => r.tool_use_id), ["a", "b"]);
  });

  it("does not run a call the user declines, and tells the model", async () => {
    const { options, conversation, messages } = setup(
      [reply([toolUse("t1", "write_file", { path: "no.txt", content: "x" })]), reply([text("ok")])],
      { authorize: async () => "The user declined this tool call." },
    );
    await runAgent(conversation, options);
    assert.ok(!existsSync(join(cwd, "no.txt")));
    const [result] = resultsIn(messages[2]);
    assert.equal(result.is_error, true);
    assert.match(String(result.content), /declined/);
  });

  it("sends invalid input back to the model instead of running the tool", async () => {
    const { options, conversation, messages } = setup([
      reply([toolUse("t1", "write_file", { path: "x.txt" })]),
      reply([toolUse("t2", "write_file", { path: "y.txt", content: "cut" })], "tool_use", new Map([["t2", '{"path":"y.txt","content":"cut']])),
      reply([text("ok")]),
    ]);
    await runAgent(conversation, options);
    const [missing] = resultsIn(messages[2]);
    assert.equal(missing.is_error, true);
    assert.match(String(missing.content), /INVALID_JSON.*missing required parameter/);
    const [broken] = resultsIn(messages[4]);
    assert.match(String(broken.content), /not valid JSON/);
    assert.ok(!existsSync(join(cwd, "x.txt")) && !existsSync(join(cwd, "y.txt")));
  });

  it("reports unknown tools as errors", async () => {
    const { options, conversation, messages } = setup([reply([toolUse("t1", "teleport", {})]), reply([text("ok")])]);
    await runAgent(conversation, options);
    assert.match(String(resultsIn(messages[2])[0].content), /Unknown tool "teleport"/);
  });

  it("does not run tool calls from a reply cut off at max_tokens", async () => {
    const { options, conversation, messages } = setup([
      reply([toolUse("t1", "write_file", { path: "half.txt", content: "trunc" })], "max_tokens"),
      reply([text("ok")]),
    ]);
    await runAgent(conversation, options);
    assert.ok(!existsSync(join(cwd, "half.txt")));
    assert.match(String(resultsIn(messages[2])[0].content), /output limit/);
  });

  it("stops at the step limit with a valid history", async () => {
    const forever = Array.from({ length: 5 }, (_, i) => reply([toolUse(`t${i}`, "bash", { command: "true" })]));
    const { options, conversation, messages } = setup(forever, { maxSteps: 3 });
    const result = await runAgent(conversation, options);
    assert.equal(result.stop, "max_steps");
    assert.equal(result.steps, 3);
    assert.equal(messages.at(-1)?.role, "user"); // ends with tool results, so the next request is valid
  });

  it("keeps a refused reply out of the history", async () => {
    const { options, conversation, messages } = setup([reply([text("Sure, here is")], "refusal")]);
    const result = await runAgent(conversation, options);
    assert.equal(result.stop, "refusal");
    assert.equal(messages.length, 1);
  });

  it("stops on Ctrl+C but still answers every tool call", async () => {
    const controller = new AbortController();
    const { options, conversation, messages } = setup([
      reply([toolUse("slow", "bash", { command: "sleep 30" }), toolUse("next", "bash", { command: "echo hi" })]),
    ]);
    setTimeout(() => controller.abort(), 100);
    const result = await runAgent(conversation, options, controller.signal);

    assert.equal(result.stop, "interrupted");
    const [slow, next] = resultsIn(messages[2]);
    assert.match(String(slow.content), /interrupted/);
    assert.match(String(next.content), /Not run/);
  });
});

describe("escalating to a stronger model", () => {
  /** The stronger model's replies, and how long the history was each time it was called. */
  function stronger(replies: ModelTurn[]) {
    const seen: number[] = [];
    const callModel = async (messages: MessageParam[]) => {
      seen.push(messages.length);
      const next = replies.shift();
      if (!next) throw new Error("the stronger model ran out of replies");
      return next;
    };
    return { seen, escalate: { model: "strong", callModel } };
  }

  it("hands the steps left to it, with the whole conversation, once a test run fails", async () => {
    const strong = stronger([reply([text("Fixed it.")])]);
    const { options, conversation } = setup([reply([toolUse("t1", "bash", { command: "false && pytest" })])], { maxSteps: 4, escalate: strong.escalate });
    const result = await runAgent(conversation, options);
    assert.equal(result.text, "Fixed it.");
    assert.deepEqual(strong.seen, [3]); // the task, the failed run and its result
    assert.equal(result.escalated?.model, "strong");
    assert.equal(result.escalated?.step, 2);
    assert.deepEqual([result.escalated?.usage.input, result.usage.input], [100, 200]);
  });

  it("keeps its own model while the tests pass, and on the last step", async () => {
    const strong = stronger([]);
    const passing = setup([reply([toolUse("t1", "bash", { command: "true || pytest" })]), reply([text("Done.")])], { maxSteps: 4, escalate: strong.escalate });
    assert.equal((await runAgent(passing.conversation, passing.options)).escalated, undefined);
    const last = setup([reply([toolUse("t1", "bash", { command: "false && pytest" })])], { maxSteps: 1, escalate: strong.escalate });
    assert.equal((await runAgent(last.conversation, last.options)).escalated, undefined, "no steps left to hand over");
    assert.deepEqual(strong.seen, []);
  });

  it("reads a failure from the runner's report when a pipe hides the exit code", () => {
    const run = (command: string, content: string) =>
      failedTestRun({ type: "tool_use", id: "t1", name: "bash", input: { command } }, { type: "tool_result", tool_use_id: "t1", content });
    const piped = "python -m unittest discover -s tests -v 2>&1 | tail -20";
    assert.equal(run(piped, "Ran 4 tests in 0.002s\n\nFAILED (failures=1, errors=1)\n\nExit code: 0"), true);
    assert.equal(run("pytest -q | tail -3", "2 failed, 7 passed in 0.31s\n\nExit code: 0"), true);
    assert.equal(run(piped, "Ran 4 tests in 0.002s\n\nOK\n\nExit code: 0"), false);
    assert.equal(run("pytest -q", "7 passed, 0 failed in 0.31s\n\nExit code: 0"), false);
    assert.equal(run("python check.py", "Traceback (most recent call last):\n\nExit code: 1"), false, "not a test runner");
  });
});

describe("a reviewer before finishing", () => {
  /** A reviewer that gives these verdicts in turn and records what it was shown. */
  function fakeReviewer(...verdicts: (ReviewVerdict | Error)[]) {
    const seen: Parameters<Reviewer["review"]>[0][] = [];
    const reviewer: Reviewer = {
      model: "strong",
      async review(work) {
        seen.push(work);
        const verdict = verdicts.shift()!;
        if (verdict instanceof Error) throw verdict;
        const usage = { input: 50, cacheWrite: 0, cacheRead: 0, output: 5 };
        return { verdict, ...(verdict === "problems" && { feedback: "A reviewer found: out.txt is missing." }), usage };
      },
    };
    return { reviewer, seen };
  }

  it("sends the problems it finds back, and the model works on", async () => {
    const { reviewer, seen } = fakeReviewer("problems");
    const { options, conversation, messages } = setup(
      [reply([toolUse("t1", "bash", { command: "echo hi > a.txt" })]), reply([text("Done.")]), reply([text("Fixed: out.txt written.")])],
      { reviewer },
    );
    const result = await runAgent(conversation, options);
    assert.equal(result.text, "Fixed: out.txt written.");
    assert.deepEqual(result.reviewed, { model: "strong", step: 2, verdict: "problems", usage: { input: 50, cacheWrite: 0, cacheRead: 0, output: 5 } });
    assert.equal(result.usage.input, 350, "the review's tokens count in the task's");
    assert.deepEqual(messages[4], { role: "user", content: "A reviewer found: out.txt is missing." });
    assert.equal(seen[0].task, "do the task");
    assert.equal(seen[0].answer, "Done.");
    assert.equal(seen[0].messages.length, 4, "the task and what the run did, up to the model's stop");
  });

  it("ends the task when it approves, and reviews once a task", async () => {
    const approves = fakeReviewer("approved");
    const approved = setup([reply([text("Done.")])], { reviewer: approves.reviewer });
    const result = await runAgent(approved.conversation, approved.options);
    assert.deepEqual([result.text, result.steps, result.reviewed?.verdict], ["Done.", 1, "approved"]);
    const once = fakeReviewer("problems");
    const twice = setup([reply([text("Done.")]), reply([text("Still done.")])], { reviewer: once.reviewer });
    assert.equal((await runAgent(twice.conversation, twice.options)).text, "Still done.");
    assert.equal(once.seen.length, 1);
  });

  it("stops as interrupted when Ctrl+C comes during the review", async () => {
    const controller = new AbortController();
    const reviewer: Reviewer = { model: "strong", async review() { controller.abort(); return { verdict: "none", usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } }; } };
    const { options, conversation } = setup([reply([text("Done.")])], { reviewer });
    assert.equal((await runAgent(conversation, options, controller.signal)).stop, "interrupted");
  });

  it("leaves the work as it is when the review fails, gives no verdict, or there is no step left", async () => {
    const failing = fakeReviewer(new Error("overloaded"));
    const failed = setup([reply([text("Done.")])], { reviewer: failing.reviewer });
    const notices: string[] = [];
    failed.options.ui = { ...failed.options.ui, notice: (n) => notices.push(n) };
    const result = await runAgent(failed.conversation, failed.options);
    assert.deepEqual([result.stop, result.text, result.reviewed], ["end_turn", "Done.", undefined]);
    assert.match(notices.join("\n"), /The review failed \(overloaded\), so the work stands as it is/);
    const silent = setup([reply([text("Done.")])], { reviewer: fakeReviewer("none").reviewer });
    assert.equal((await runAgent(silent.conversation, silent.options)).reviewed?.verdict, "none");
    const last = fakeReviewer("problems");
    const lastStep = setup([reply([text("Done.")])], { reviewer: last.reviewer, maxSteps: 1 });
    assert.equal((await runAgent(lastStep.conversation, lastStep.options)).text, "Done.");
    assert.equal(last.seen.length, 0);
  });
});
