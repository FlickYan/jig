import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { failedTestRun, MAX_STOP_BLOCKS, runAgent, runsSomething, SAME_STEPS, WRAP_UP, type AgentOptions, type Reviewer, type ReviewVerdict } from "../src/agent.ts";
import { Conversation } from "../src/conversation.ts";
import { OutputFiles } from "../src/tools/bash.ts";
import type { CallModel, ModelTurn } from "../src/model.ts";
import { toChatMessages } from "../src/openai.ts";
import { TOOLS, type Tool } from "../src/tools/index.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

type Block = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;
const thinking = (t: string) => ({ type: "thinking", thinking: t, signature: "sig" }) as Block;

function reply(content: Block[], stopReason?: Anthropic.Beta.BetaStopReason, malformed = new Map<string, string>()): ModelTurn {
  const stop_reason = stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id: "msg", type: "message", role: "assistant", model: "fake", content, stop_reason, usage };
  return { message: message as Anthropic.Beta.BetaMessage, malformed };
}

/**
 * Test setup: a fake model that plays back scripted replies and records how long the history was at each
 * call. Asked for a summary, it gives one.
 */
function setup(replies: ModelTurn[], overrides: Partial<AgentOptions> = {}) {
  const historyLengths: number[] = [];
  const summaries: MessageParam[][] = [];
  const options: AgentOptions = {
    callModel: async (messages, _signal, { summarize } = {}) => {
      if (summarize) {
        summaries.push(messages);
        return reply([text("SUMMARY: half the plan is written.")]);
      }
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
  return { options, conversation, messages: conversation.messages, historyLengths, summaries };
}

function resultsIn(message: MessageParam): ToolResult[] {
  return message.content as ToolResult[];
}

let cwd: string;
beforeEach(async () => {
  cwd = await tempDir("jig-agent-");
});
afterEach(removeTempDirs);

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

  it("doesn't ask on the last step, where no step is left to check: the answer stands", async () => {
    const { options, conversation, messages } = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([text("All done.")])], { review: REVIEW, maxSteps: 2 });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "All done.", 2]);
    assert.equal(messages.at(-1)?.role, "assistant", "the session ends on the answer, not on an unanswered request");
  });

  it("doesn't ask too close to the time limit, then or at a later stop, and says so once", async () => {
    const notices: string[] = [];
    const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
    const verdicts = ["tests fail", null];
    const late = setup([reply([text("Done.")]), reply([text("Fixed.")])], { review: REVIEW, checkUntil: Date.now(), stopHooks: async () => verdicts.shift()!, ui });
    const result = await runAgent(late.conversation, late.options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "Fixed.", 2]);
    assert.ok(!late.messages.some((m) => m.content === REVIEW));
    assert.deepEqual(notices.filter((n) => n.startsWith("Too little time")), ["Too little time is left to check the work (--time-limit), so it stands as it is."]);
    // With time left, it asks as before.
    const early = setup([reply([text("Done.")]), reply([text("Checked.")])], { review: REVIEW, checkUntil: Date.now() + 60_000 });
    assert.equal((await runAgent(early.conversation, early.options)).text, "Checked.");
    assert.deepEqual(early.messages[2], { role: "user", content: REVIEW });
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

  it("sends back only the start of a long invalid input, and what came just before the error", async () => {
    const raw = `{"path":"big.txt","content":"${"line\\n".repeat(30_000)}`; // cut off mid-string, as at an output limit
    const { options, conversation, messages } = setup([
      reply([toolUse("t1", "write_file", {})], "tool_use", new Map([["t1", raw]])),
      reply([text("ok")]),
    ]);
    await runAgent(conversation, options);
    const [result] = resultsIn(messages[2]);
    const sent = JSON.parse(String(result.content));
    assert.ok(String(result.content).length < 3_500, `${String(result.content).length} characters`);
    assert.ok(sent.INVALID_JSON.startsWith('{"path":"big.txt","content":"line'));
    assert.ok(sent.BEFORE_ERROR.endsWith("line\\n"));
    assert.match(sent.error, /not valid JSON \(Unterminated string in JSON at position 180029/);
    assert.match(sent.shown, /first 2000 characters, and the 400 before the error, of 180029/);
    assert.ok(!existsSync(join(cwd, "big.txt")));
  });

  it("doesn't run a tool the request didn't offer", async () => {
    const offered = (turn: ModelTurn, names: string[]) => ({ ...turn, offered: names });
    const { options, conversation, messages } = setup([
      offered(reply([toolUse("t1", "bash", { command: "touch ran.txt" }), toolUse("t2", "write_file", { path: "w.txt", content: "x" })]), ["write_file", "edit_file"]),
      reply([text("ok")]),
    ]);
    await runAgent(conversation, options);
    const [bash, write] = resultsIn(messages[2]);
    assert.equal(bash.is_error, true);
    assert.equal(bash.content, "Not run: bash isn't one of the tools offered for this step. Available: write_file, edit_file.");
    assert.ok(!existsSync(join(cwd, "ran.txt")));
    assert.equal(write.is_error, undefined);
    assert.ok(existsSync(join(cwd, "w.txt")));
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

  it("leaves an empty reply out of the history and asks the model once to go on", async () => {
    const notices: string[] = [];
    const { options, conversation, messages, historyLengths } = setup([reply([]), reply([text("Done.")])], {
      ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
    });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "Done.", 2]);
    assert.deepEqual(historyLengths, [1, 2]);
    assert.deepEqual(messages[1], { role: "user", content: "Your last reply was empty: continue the task, calling a tool or giving your answer." });
    assert.deepEqual(messages.map((m) => m.role), ["user", "user", "assistant"]);
    assert.deepEqual(notices, ["The model replied without text or a tool call; asking it to go on."]);
  });

  it("ends the run on a second empty reply as empty, not finished, with a valid history", async () => {
    const notices: string[] = [];
    const twice = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([]), reply([text(" \n")])], {
      ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
    });
    const result = await runAgent(twice.conversation, twice.options);
    assert.deepEqual([result.stop, result.text.trim(), result.steps], ["empty", "", 3]);
    assert.deepEqual(twice.messages.map((m) => m.role), ["user", "assistant", "user", "user"]);
    assert.equal(notices.at(-1), "The model replied without text or a tool call, so the task ends without an answer.");
    // Every assistant message holds something to send back, in either API's format.
    assert.ok(twice.messages.every((m) => m.role === "user" || (m.content as Block[]).some((b) => b.type === "tool_use" || (b.type === "text" && b.text.trim()))));
    assert.ok(toChatMessages("", twice.messages).every((m) => m.role !== "assistant" || m.content || m.tool_calls));
    // A reply that says why it stopped short ends the run with that reason, as before.
    const cut = setup([reply([thinking("Every case")], "max_tokens"), reply([thinking("Every case, again")], "max_tokens")]);
    assert.equal((await runAgent(cut.conversation, cut.options)).stop, "max_tokens");
  });

  it("ends the run out of steps on an empty reply at the last step, says so, and asks for the wrap-up as at any other", async () => {
    const notices: string[] = [];
    const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
    const last = setup([reply([])], { maxSteps: 1, ui });
    assert.deepEqual(await runAgent(last.conversation, last.options).then((r) => [r.stop, r.steps]), ["max_steps", 1]);
    assert.equal(last.messages.length, 1);
    assert.deepEqual(notices.splice(0), ["The model replied without text or a tool call on the last step."]);
    const wrapped = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([thinking("Nothing to add.")])], { maxSteps: 2, wrapUp: true, ui });
    const result = await runAgent(wrapped.conversation, wrapped.options);
    assert.deepEqual([result.stop, result.steps, result.text], ["max_steps", 2, "SUMMARY: half the plan is written."]);
    assert.deepEqual(wrapped.summaries.map((messages) => messages.at(-1)), [{ role: "user", content: WRAP_UP }]);
    // The user hears why the last step did nothing before the request for the wrap-up.
    assert.deepEqual(notices, ["The model replied without text or a tool call on the last step.", "Out of steps: asking the model where the work stands."]);
    // After two empty replies, the note asking for a tool call was never answered: the wrap-up takes it back.
    const twice = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([]), reply([])], { maxSteps: 3, wrapUp: true, ui });
    assert.equal((await runAgent(twice.conversation, twice.options)).stop, "max_steps");
    assert.deepEqual(twice.summaries[0].slice(-2).map((message) => (typeof message.content === "string" ? message.content : message.content[0].type)), ["tool_result", WRAP_UP]);
  });

  it("checks no work on an empty end: there is no answer for --check, the reviewer or the Stop hooks", async () => {
    let checks = 0;
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const reviewer: Reviewer = { model: "strong", review: async () => (checks++, { verdict: "problems", feedback: "PROBLEMS: nothing was done.", usage }) };
    const stopHooks = async () => (checks++, "tests fail");
    for (const overrides of [{ review: "Check your work." }, { reviewer }, { stopHooks }]) {
      const { options, conversation, messages } = setup([reply([]), reply([thinking("Done, I think.")])], overrides);
      assert.deepEqual(await runAgent(conversation, options).then((r) => [r.stop, r.steps]), ["empty", 2]);
      assert.ok(!messages.some((m) => m.content === "Check your work."));
    }
    assert.equal(checks, 0);
  });

  it("handles a reply with only thinking like an empty one", async () => {
    const { options, conversation, messages } = setup([reply([thinking("It is done.")]), reply([thinking("So"), text("Done.")])]);
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "Done.", 2]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "user", "assistant"]);
    const twice = setup([reply([thinking("It is done.")]), reply([thinking("It really is.")])]);
    assert.equal((await runAgent(twice.conversation, twice.options)).stop, "empty");
    // Thinking that ran into the output limit gets told so.
    const cut = setup([reply([thinking("Let me think about every case")], "max_tokens"), reply([text("Done.")])]);
    assert.equal((await runAgent(cut.conversation, cut.options)).text, "Done.");
    assert.match(String(cut.messages[1].content), /^Your last reply was cut off at the output limit before any text or tool call/);
  });

  it("asks for the rest of a reply cut off at the output limit, and returns the whole answer", async () => {
    const notices: string[] = [];
    const { options, conversation, messages } = setup([reply([text("The plan: first, ")], "max_tokens"), reply([text("then second.")])], {
      ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
    });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "The plan: first, then second.", 2]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.deepEqual(messages[2], { role: "user", content: "Your reply was cut off at the output limit; continue from where it stopped, more briefly." });
    assert.deepEqual(notices, ["The reply was cut off at the output limit; asking the model to continue."]);
    // Once it has finished that answer, the next one stands on its own.
    const checked = setup([reply([text("Done, ")], "max_tokens"), reply([text("all of it.")]), reply([text("Checked.")])], { review: "Check your work." });
    assert.equal((await runAgent(checked.conversation, checked.options)).text, "Checked.");
  });

  it("continues a cut-off reply twice at most, and not on the last step", async () => {
    const cutOff = (t: string) => reply([text(t)], "max_tokens");
    const thrice = setup([cutOff("a"), cutOff("b"), cutOff("c"), reply([text("never asked for")])]);
    const result = await runAgent(thrice.conversation, thrice.options);
    assert.deepEqual([result.stop, result.text, result.steps], ["max_tokens", "abc", 3]);
    assert.equal(thrice.messages.length, 6);
    const last = setup([cutOff("a")], { maxSteps: 1 });
    assert.deepEqual(await runAgent(last.conversation, last.options).then((r) => [r.stop, r.text, r.steps]), ["max_tokens", "a", 1]);
  });

  it("lets the reply after a compaction stand alone: the summary took in the one it would have continued", async () => {
    const { options, conversation, messages, historyLengths } = setup([reply([text("The plan: first, ")], "max_tokens"), reply([text("The plan: first, then second.")])], { compactAt: 100 });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "The plan: first, then second.", 2]);
    // The note asking for the rest went into the summary too, so it doesn't point at text the model can't see.
    assert.deepEqual(historyLengths, [1, 1]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.match(String(messages[0].content), /SUMMARY: half the plan is written\.\n\nThe task you are working on, word for word:\n\ndo the task\n\nContinue the task from where it stopped\.$/);
    // The same for the note after an empty reply.
    const empty = setup([reply([]), reply([text("Done.")])], { compactAt: 99 });
    assert.equal((await runAgent(empty.conversation, empty.options)).text, "Done.");
    assert.deepEqual(empty.messages.map((m) => m.role), ["user", "assistant"]);
    assert.match(String(empty.messages[0].content), /Continue the task from where it stopped\.$/);
  });

  it("stops at the step limit with a valid history", async () => {
    const forever = Array.from({ length: 5 }, (_, i) => reply([toolUse(`t${i}`, "bash", { command: "true" })]));
    const { options, conversation, messages, summaries } = setup(forever, { maxSteps: 3 });
    const result = await runAgent(conversation, options);
    assert.equal(result.stop, "max_steps");
    assert.equal(result.steps, 3);
    assert.equal(result.text, "");
    assert.equal(messages.at(-1)?.role, "user"); // ends with tool results, so the next request is valid
    assert.equal(summaries.length, 0, "without wrapUp (--no-wrap-up), nothing more is asked");
  });

  it("at the step limit, asks once more, without tools, where the work stands", async () => {
    const forever = Array.from({ length: 5 }, (_, i) => reply([toolUse(`t${i}`, "bash", { command: "true" })]));
    const notices: string[] = [];
    const { options, conversation, messages, historyLengths, summaries } = setup(forever, {
      maxSteps: 3,
      wrapUp: true,
      ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
    });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.steps, result.text], ["max_steps", 3, "SUMMARY: half the plan is written."]);
    assert.deepEqual(historyLengths, [1, 3, 5]);
    // One call more, with summarize: the tools stay declared, but none may be called.
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0].at(-1), { role: "user", content: WRAP_UP });
    assert.equal(result.usage.input, 400, "its tokens count in the run's");
    // The request and the reply join the history, after the last step's results, and it ends on the reply.
    assert.deepEqual(resultsIn(messages[6]).map((r) => r.tool_use_id), ["t2"]);
    assert.deepEqual(messages.slice(7), [
      { role: "user", content: WRAP_UP },
      { role: "assistant", content: [text("SUMMARY: half the plan is written.")] },
    ]);
    assert.deepEqual(notices, ["Out of steps: asking the model where the work stands."]);
  });

  /** A run that calls a tool at every step, up to its limit of 3, and whose wrap-up gets `answer`. */
  function outOfSteps(answer: () => Promise<ModelTurn>) {
    const notices: string[] = [];
    let step = 0;
    const callModel: CallModel = async (_messages, _signal, { summarize } = {}) => (summarize ? answer() : reply([toolUse(`t${++step}`, "bash", { command: "true" })]));
    const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
    return { notices, ...setup([], { maxSteps: 3, wrapUp: true, callModel, ui }) };
  }

  it("runs no tool call the wrap-up makes anyway, and keeps it out of the history", async () => {
    // A server can ignore tool_choice.
    const late = toolUse("w", "write_file", { path: "late.txt", content: "x" });
    const { options, conversation, messages } = outOfSteps(async () => reply([thinking("Out of steps."), text("The parser is fixed; the tests are left."), late]));
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text], ["max_steps", "The parser is fixed; the tests are left."]);
    assert.ok(!existsSync(join(cwd, "late.txt")));
    assert.deepEqual(messages.at(-1), { role: "assistant", content: [thinking("Out of steps."), text("The parser is fixed; the tests are left.")] });
  });

  it("leaves the run as it was when the wrap-up fails or says nothing, and stops on Ctrl+C during it", async () => {
    const failed = outOfSteps(async () => {
      throw new Error("overloaded");
    });
    const result = await runAgent(failed.conversation, failed.options);
    assert.deepEqual([result.stop, result.text, result.steps], ["max_steps", "", 3]);
    assert.deepEqual(failed.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    assert.equal(failed.notices.at(-1), "The wrap-up failed (overloaded), so the task ends without one.");
    // Nothing to show, the request stays out of the history too: no request is left unanswered there.
    const silent = outOfSteps(async () => reply([thinking("Nothing to say.")]));
    assert.deepEqual(await runAgent(silent.conversation, silent.options).then((r) => [r.stop, r.text]), ["max_steps", ""]);
    assert.equal(silent.messages.length, 7);
    const refused = outOfSteps(async () => reply([text("I can't")], "refusal"));
    assert.deepEqual(await runAgent(refused.conversation, refused.options).then((r) => [r.stop, r.text]), ["max_steps", ""]);
    assert.equal(refused.messages.length, 7);
    const controller = new AbortController();
    const interrupted = outOfSteps(async () => {
      controller.abort();
      throw new Error("Request was aborted.");
    });
    assert.equal((await runAgent(interrupted.conversation, interrupted.options, controller.signal)).stop, "interrupted");
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

  it("says what stopped the calls when the task is stopped with words, as at --time-limit", async () => {
    const controller = new AbortController();
    const { options, conversation, messages } = setup([
      reply([toolUse("slow", "bash", { command: "sleep 30" }), toolUse("next", "bash", { command: "echo hi" })]),
    ]);
    setTimeout(() => controller.abort("the time limit (--time-limit) was reached"), 100);
    assert.equal((await runAgent(conversation, options, controller.signal)).stop, "interrupted");
    const [slow, next] = resultsIn(messages[2]);
    assert.match(String(slow.content), /\n\nKilled: the time limit \(--time-limit\) was reached\.$/);
    assert.deepEqual([next.is_error, next.content], [true, "Not run: the time limit (--time-limit) was reached."]);
  });

  it("doesn't run a call approved after the task was stopped, as at --time-limit during the question", async () => {
    const controller = new AbortController();
    const authorize = async () => {
      controller.abort("the time limit (--time-limit) was reached");
      return null;
    };
    const { options, conversation, messages } = setup([reply([toolUse("t1", "bash", { command: "touch ran.txt" })])], { authorize });
    assert.equal((await runAgent(conversation, options, controller.signal)).stop, "interrupted");
    assert.equal(resultsIn(messages[2])[0].content, "Not run: the time limit (--time-limit) was reached.");
    assert.ok(!existsSync(join(cwd, "ran.txt")));
  });

  it("doesn't run a call when Ctrl+C comes while the hooks check it", async () => {
    // Ctrl+C kills a hook, which only warns, so the hooks let the call through: the loop has to notice.
    const controller = new AbortController();
    const before = async () => {
      controller.abort();
      return null;
    };
    const { options, conversation, messages } = setup([reply([toolUse("t1", "bash", { command: "touch ran.txt" })])], { hooks: { before, after: async () => null } });
    const result = await runAgent(conversation, options, controller.signal);
    assert.equal(result.stop, "interrupted");
    const [call] = resultsIn(messages[2]);
    assert.deepEqual([call.is_error, call.content], [true, "Not run: the user interrupted."]);
    assert.ok(!existsSync(join(cwd, "ran.txt")));
  });
});

describe("a check around a tool call that throws", () => {
  const crash = (what: string) => async (): Promise<never> => {
    throw new Error(`${what} crashed`);
  };

  it("fails only the calls a hook was checking, and the run goes on", async () => {
    const { options, conversation, messages } = setup(
      [reply([toolUse("a", "read_file", { path: "x.txt" }), toolUse("b", "glob", { pattern: "*" })]), reply([text("Done.")])],
      { hooks: { before: crash("the hook"), after: async () => null } },
    );
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text], ["end_turn", "Done."]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    for (const [i, id] of ["a", "b"].entries()) {
      const answer = resultsIn(messages[2])[i];
      assert.deepEqual([answer.tool_use_id, answer.is_error, answer.content], [id, true, "Not run: the PreToolUse hooks failed: the hook crashed"]);
    }
  });

  it("doesn't run a call whose permission check throws; a PostToolUse hook that throws leaves the result as it is", async () => {
    const notices: string[] = [];
    const { options, conversation, messages } = setup(
      [reply([toolUse("w", "write_file", { path: "w.txt", content: "x" }), toolUse("e", "bash", { command: "echo ran" })]), reply([text("Done.")])],
      {
        authorize: async (tool) => (tool.kind === "edit" ? crash("the permission check")() : null),
        hooks: { before: async () => null, after: crash("the linter") },
        ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
      },
    );
    assert.equal((await runAgent(conversation, options)).text, "Done.");
    const [write, bash] = resultsIn(messages[2]);
    assert.deepEqual([write.is_error, write.content], [true, "Not run: the permission check failed: the permission check crashed"]);
    assert.ok(!existsSync(join(cwd, "w.txt")));
    assert.deepEqual([bash.is_error, bash.content], [undefined, "ran\n\nExit code: 0"]);
    assert.deepEqual(notices, ["The PostToolUse hooks failed: the linter crashed"]);
  });

  it("still runs a call the tool can't describe", async () => {
    const odd: Tool = {
      definition: { name: "odd", description: "", input_schema: { type: "object", properties: {} } },
      kind: "read",
      describe: () => {
        throw new Error("no words for it");
      },
      run: async () => "ran",
    };
    const shown: string[] = [];
    const { options, conversation, messages } = setup([reply([toolUse("o", "odd", { n: 1 })]), reply([text("Done.")])], {
      tools: [...TOOLS, odd],
      ui: { toolCall: (_name, description) => shown.push(description), toolResult() {}, notice() {} },
    });
    await runAgent(conversation, options);
    assert.deepEqual(shown, ['{"n":1}']);
    assert.equal(resultsIn(messages[2])[0].content, "ran");
  });

  it("answers the calls left open when handling them fails anyway, before the error ends the run", async () => {
    let calls = 0;
    const ui = {
      toolCall() {
        if (++calls === 2) throw new Error("the terminal is gone");
      },
      toolResult() {},
      notice() {},
    };
    const { options, conversation, messages } = setup([reply([toolUse("a", "bash", { command: "echo one" }), toolUse("b", "bash", { command: "echo two" })])], { ui });
    await assert.rejects(runAgent(conversation, options), /the terminal is gone/);
    const [a, b] = resultsIn(messages[2]);
    assert.deepEqual([a.tool_use_id, a.content], ["a", "one\n\nExit code: 0"]);
    assert.deepEqual([b.tool_use_id, b.is_error, b.content], ["b", true, "No result: jig failed while handling this call (the terminal is gone)."]);
  });
});

describe("a model that repeats itself", () => {
  const REPEAT = "Not run: identical to an earlier call in this reply (call 1).";

  it("runs a call repeated within one reply once, and answers the repeats without running them", async () => {
    await writeFile(join(cwd, "a.py"), "x = 1\n");
    const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
    const edit = { path: "a.py", old_string: "x = 1", new_string: "x = 1  # checked" };
    const { options, conversation, messages } = setup([reply(ids.map((id) => toolUse(id, "edit_file", edit))), reply([text("Done.")])]);
    assert.equal((await runAgent(conversation, options)).text, "Done.");
    assert.equal(await readFile(join(cwd, "a.py"), "utf8"), "x = 1  # checked\n", "the edit ran once, not ten times");
    const results = resultsIn(messages[2]);
    assert.deepEqual(results.map((r) => r.tool_use_id), ids, "every call is answered, in order");
    assert.equal(results[0].is_error, undefined);
    for (const repeat of results.slice(1)) assert.deepEqual([repeat.is_error, repeat.content], [true, REPEAT]);
  });

  it("tells a repeat from a call that differs, whatever the order of its input's keys", async () => {
    const { options, conversation, messages } = setup([
      reply([
        toolUse("a", "bash", { command: "echo one >> log.txt", timeout: 5 }),
        toolUse("b", "bash", { timeout: 5, command: "echo one >> log.txt" }),
        toolUse("c", "bash", { command: "echo two >> log.txt" }),
        toolUse("d", "bash", { command: "echo two >> log.txt", timeout: 6 }),
      ]),
      // Read-only calls run at the same time; a repeat among them doesn't run either.
      reply([toolUse("r1", "read_file", { path: "log.txt" }), toolUse("r2", "read_file", { path: "log.txt" })]),
      // Input that isn't JSON is compared as it was written, not as the lenient parser read it.
      reply([toolUse("m1", "write_file", {}), toolUse("m2", "write_file", {})], "tool_use", new Map([["m1", '{"path":"a'], ["m2", '{"path":"b']])),
      reply([text("Done.")]),
    ]);
    await runAgent(conversation, options);
    assert.equal(await readFile(join(cwd, "log.txt"), "utf8"), "one\ntwo\ntwo\n");
    assert.deepEqual(resultsIn(messages[2]).map((r) => r.content === REPEAT), [false, true, false, false]);
    const [read, repeat] = resultsIn(messages[4]);
    assert.match(String(read.content), /1\tone\n\s+2\ttwo\n\s+3\ttwo/);
    assert.equal(repeat.content, REPEAT);
    assert.deepEqual(resultsIn(messages[6]).map((r) => /INVALID_JSON/.test(String(r.content))), [true, true]);
  });

  it("runs a repeat again once a call between them may have changed something", async () => {
    await writeFile(join(cwd, "check.sh"), "grep -q good value.txt && echo PASS || { echo FAIL; exit 1; }\n");
    await writeFile(join(cwd, "value.txt"), "good\n");
    const test = { command: "sh check.sh" };
    const fix = { path: "value.txt", old_string: "bad", new_string: "good" };
    const { options, conversation, messages } = setup([
      reply([
        toolUse("t1", "bash", test),
        toolUse("e1", "edit_file", { path: "value.txt", old_string: "good", new_string: "bad" }),
        toolUse("t2", "bash", test),
        toolUse("r1", "read_file", { path: "value.txt" }),
        toolUse("e2", "edit_file", fix),
        toolUse("r2", "read_file", { path: "value.txt" }),
        // The second edit and read again: nothing that may change anything has run since, so they don't.
        toolUse("e3", "edit_file", fix),
        toolUse("r3", "read_file", { path: "value.txt" }),
      ]),
      reply([text("Done.")]),
    ]);
    await runAgent(conversation, options);
    const results = resultsIn(messages[2]).map((r) => String(r.content));
    assert.match(results[0], /^PASS/);
    assert.match(results[2], /^FAIL/, "the test run after the edit ran, rather than pointing at the one before it");
    assert.match(results[3], /1\tbad/);
    assert.match(results[5], /1\tgood/, "so did the read after the second edit");
    assert.deepEqual(results.slice(6), ["Not run: identical to an earlier call in this reply (call 5).", "Not run: identical to an earlier call in this reply (call 6)."]);
  });

  it("stops a run whose model makes the same calls, with the same results, 5 steps in a row", async () => {
    const again = Array.from({ length: 8 }, (_, i) => reply([text("Let me look again."), toolUse(`t${i}`, "read_file", { path: "missing.txt" })]));
    const { options, conversation, messages, historyLengths, summaries } = setup(again, { wrapUp: true });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.steps, result.text], ["loop", 5, ""]);
    assert.equal(historyLengths.length, 5);
    assert.equal(summaries.length, 0, "it is no report on work, so no wrap-up is asked for");
    assert.equal(messages.at(-1)?.role, "user", "it ends on the calls' results, so the conversation can go on");
  });

  it("doesn't stop a call whose result changes, or a run of repeats another call broke", async () => {
    const counting = Array.from({ length: 7 }, (_, i) => reply([toolUse(`t${i}`, "bash", { command: "echo x >> log.txt && wc -l < log.txt" })]));
    const polling = setup([...counting, reply([text("Done.")])]);
    assert.deepEqual(await runAgent(polling.conversation, polling.options).then((r) => [r.stop, r.steps]), ["end_turn", 8]);
    const same = (i: number) => reply([toolUse(`s${i}`, "bash", { command: "true" })]);
    const other = reply([toolUse("o", "bash", { command: "echo other" })]);
    const broken = setup([same(1), same(2), same(3), same(4), other, same(5), same(6), same(7), same(8), reply([text("Done.")])]);
    assert.deepEqual(await runAgent(broken.conversation, broken.options).then((r) => [r.stop, r.steps]), ["end_turn", 10]);
  });

  it("counts again after a step without calls, which gives the model something new to act on", async () => {
    const same = (i: number) => reply([toolUse(`s${i}`, "bash", { command: "true" })]);
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const reviewer: Reviewer = { model: "strong", review: async () => ({ verdict: "problems", feedback: "PROBLEMS: start the server first.", usage }) };
    const between: [ModelTurn, Partial<AgentOptions>][] = [
      [reply([text("It's down.")]), { review: "Check your work." }], // --check's request
      [reply([text("It's down.")]), { reviewer }], // the reviewer's problems
      [reply([]), {}], // an empty reply: the model is asked to go on
      [reply([text("It's do")], "max_tokens"), {}], // cut off: the model is asked to continue
    ];
    for (const [step, overrides] of between) {
      const { options, conversation } = setup([same(1), same(2), same(3), same(4), step, same(5), reply([text("Still down.")])], overrides);
      assert.deepEqual(await runAgent(conversation, options).then((r) => [r.stop, r.steps]), ["end_turn", 7]);
    }
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

  it("asks the model that took over for the wrap-up at the step limit", async () => {
    const strong = stronger([reply([toolUse("t2", "bash", { command: "true" })]), reply([text("Half fixed; pytest still fails.")])]);
    const { options, conversation } = setup([reply([toolUse("t1", "bash", { command: "false && pytest" })])], { maxSteps: 2, escalate: strong.escalate, wrapUp: true });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text], ["max_steps", "Half fixed; pytest still fails."]);
    assert.deepEqual(strong.seen, [3, 6], "its step, then the wrap-up, the request added");
    assert.deepEqual([result.escalated?.usage.input, result.usage.input], [200, 300]);
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
    // What it said instead is quoted, and marked as cut only if it was: "Looks fine." read as cut off.
    for (const [said, shown] of [["Looks\n  fine.", "Looks fine."], ["x".repeat(200), `${"x".repeat(160)}…`]]) {
      const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
      const talking = setup([reply([text("Done.")])], { reviewer: { model: "strong", review: async () => ({ verdict: "none", text: said, usage }) } });
      notices.length = 0;
      await runAgent(talking.conversation, { ...talking.options, ui: { ...talking.options.ui, notice: (n) => notices.push(n) } });
      assert.equal(notices.at(-1), `strong gave no verdict (it said: "${shown}"), so the work stands as it is.`);
    }
    const last = fakeReviewer("problems");
    const lastStep = setup([reply([text("Done.")])], { reviewer: last.reviewer, maxSteps: 1 });
    assert.equal((await runAgent(lastStep.conversation, lastStep.options)).text, "Done.");
    assert.equal(last.seen.length, 0);
  });

  it("doesn't start too close to the time limit, and the work stands", async () => {
    const late = fakeReviewer("problems");
    const { options, conversation } = setup([reply([text("Done.")])], { reviewer: late.reviewer, checkUntil: Date.now() });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.reviewed], ["end_turn", "Done.", undefined]);
    assert.equal(late.seen.length, 0);
    const early = fakeReviewer("approved");
    const inTime = setup([reply([text("Done.")])], { reviewer: early.reviewer, checkUntil: Date.now() + 60_000 });
    assert.equal((await runAgent(inTime.conversation, inTime.options)).reviewed?.verdict, "approved");
  });
});

describe("Stop hooks before finishing", () => {
  /** What the hooks were asked, without the session file (the tests have none). */
  type Asked = { task: string; answer: string; active: boolean };
  const notices: string[] = [];
  const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
  beforeEach(() => {
    notices.length = 0;
  });

  it("send the model back with what they report, and let the task end once they pass", async () => {
    const asked: Asked[] = [];
    const verdicts = ["2 tests failed: test_parse, test_empty", null];
    const { options, conversation, messages } = setup(
      [reply([text("Done.")]), reply([toolUse("t1", "bash", { command: "echo fixed" })]), reply([text("Fixed; the tests pass.")])],
      { stopHooks: async ({ task, answer, active }) => (asked.push({ task, answer, active }), verdicts.shift()!), ui },
    );
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.steps, result.text], ["end_turn", 3, "Fixed; the tests pass."]);
    assert.deepEqual(messages[2], {
      role: "user",
      content: "A Stop hook, a check this project runs before a task may end, says the task isn't done:\n\n2 tests failed: test_parse, test_empty\n\nDeal with what it reports, then finish.",
    });
    // Asked again with stop_hook_active, as Claude Code's are, so a hook can let the model go the second time.
    assert.deepEqual(asked, [
      { task: "do the task", answer: "Done.", active: false },
      { task: "do the task", answer: "Fixed; the tests pass.", active: true },
    ]);
    assert.deepEqual(notices, ['A Stop hook says the task isn\'t done ("2 tests failed: test_parse, test_empty"); the model goes on (1 of 3).']);
    // A whole test suite's output is cut from the middle, as a tool's would be.
    const verbose = ["FAIL test_parse\n".repeat(10_000), null];
    const long = setup([reply([text("Done.")]), reply([text("Fixed.")])], { stopHooks: async () => verbose.shift()! });
    await runAgent(long.conversation, long.options);
    const sent = String(long.messages[2].content);
    assert.ok(sent.length < 41_000, `${sent.length} characters`);
    assert.match(sent, /characters truncated/);
  });

  it(`end the task, with a notice, once they have sent the model back ${MAX_STOP_BLOCKS} times`, async () => {
    let runs = 0;
    const events: string[] = [];
    const answers = Array.from({ length: 6 }, (_, i) => reply([text(`Done (${i}).`)]));
    const { options, conversation, messages } = setup(answers, { stopHooks: async () => (runs++, "tests fail"), count: (event) => events.push(event), ui });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.steps, result.text], ["end_turn", 4, "Done (3)."]);
    assert.equal(runs, 4);
    assert.deepEqual(events, ["hook.stopBlocked", "hook.stopBlocked", "hook.stopBlocked", "hook.stopCapped"]);
    assert.equal(notices.at(-1), 'A Stop hook still says the task isn\'t done ("tests fail"), but it has sent the model back 3 times, so the task ends.');
    assert.equal(messages.at(-1)?.role, "assistant", "the session ends on the answer");
  });

  it("run on the last step too once they have sent the model back, only to say whether they still object", async () => {
    // The task ended as finished, without a word, though the project's check last said it wasn't done.
    let runs = 0;
    const events: string[] = [];
    const objecting = setup([reply([text("Done.")]), reply([text("Done again.")])], { stopHooks: async () => (runs++, "tests fail"), count: (event) => events.push(event), maxSteps: 2, ui });
    assert.deepEqual(await runAgent(objecting.conversation, objecting.options).then((r) => [r.stop, r.steps, r.text]), ["end_turn", 2, "Done again."]);
    assert.equal(runs, 2);
    assert.deepEqual(events, ["hook.stopBlocked", "hook.stopCapped"]);
    assert.equal(notices.at(-1), 'A Stop hook still says the task isn\'t done ("tests fail"), but no step is left (--max-steps), so the task ends.');
    notices.length = 0;
    const verdicts = ["tests fail", null];
    const passing = setup([reply([text("Done.")]), reply([text("Fixed.")])], { stopHooks: async () => verdicts.shift()!, maxSteps: 2, ui });
    assert.equal((await runAgent(passing.conversation, passing.options)).text, "Fixed.");
    assert.equal(verdicts.length, 0, "asked again on the last step");
    assert.deepEqual(notices, ['A Stop hook says the task isn\'t done ("tests fail"); the model goes on (1 of 3).']);
  });

  it("don't run with no step left to act on what they say, or on a reply that isn't an answer", async () => {
    let runs = 0;
    const stopHooks = async () => (runs++, "tests fail");
    const last = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([text("Done.")])], { stopHooks, maxSteps: 2 });
    assert.deepEqual(await runAgent(last.conversation, last.options).then((r) => [r.stop, r.text]), ["end_turn", "Done."]);
    const cutOff = (t: string) => reply([text(t)], "max_tokens");
    const unfinished = setup([cutOff("a"), cutOff("b"), cutOff("c")], { stopHooks });
    assert.equal((await runAgent(unfinished.conversation, unfinished.options)).stop, "max_tokens");
    assert.equal(runs, 0);
  });

  it("run after --check's request and after a reviewer, at the model's next stop or the same one", async () => {
    const asked: string[] = [];
    const stopHooks = async ({ answer }: Asked) => (asked.push(answer), null);
    const checked = setup([reply([text("Done.")]), reply([text("Checked.")])], { stopHooks, review: "Check your work." });
    assert.equal((await runAgent(checked.conversation, checked.options)).text, "Checked.");
    const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const reviewer: Reviewer = { model: "strong", review: async () => ({ verdict: "approved", usage }) };
    const reviewed = setup([reply([text("Reviewed.")])], { stopHooks, reviewer });
    assert.equal((await runAgent(reviewed.conversation, reviewed.options)).reviewed?.verdict, "approved");
    assert.deepEqual(asked, ["Checked.", "Reviewed."]);
  });

  it("leave the work as it is when they fail, and stop the task on Ctrl+C during them", async () => {
    const failing = setup([reply([text("Done.")])], {
      stopHooks: async () => {
        throw new Error("bash is missing");
      },
      ui,
    });
    assert.deepEqual(await runAgent(failing.conversation, failing.options).then((r) => [r.stop, r.text]), ["end_turn", "Done."]);
    assert.deepEqual(notices, ["The Stop hooks failed (bash is missing), so the task ends."]);
    const controller = new AbortController();
    // Ctrl+C kills a hook, which then only warns: the loop has to notice.
    const stopHooks = async () => (controller.abort(), null);
    const interrupted = setup([reply([text("Done.")])], { stopHooks });
    assert.equal((await runAgent(interrupted.conversation, interrupted.options, controller.signal)).stop, "interrupted");
  });
});

describe("telling the model its budget (budget notes)", () => {
  const LAST_STEP = "(Note from jig: your next reply is the last step whose tool calls run. Make sure your changes are saved and checked; don't start new exploration.)";
  /** What follows the tool results in each message of them: the note, if there was one. */
  const notesIn = (messages: MessageParam[]) =>
    messages
      .filter((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))
      .map((m) => (m.content as { type: string; text?: string }[]).flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
  // Calls that start no process, so a step takes milliseconds: the times below allow up to 900.
  const steps = (n: number) => Array.from({ length: n }, (_, i) => reply([toolUse(`t${i}`, "read_file", { path: `missing-${i}.txt` })]));
  /** A task that began `gone` milliseconds ago and has `total` in all. */
  const clock = (gone: number, total: number) => ({ begun: Date.now() - gone, deadline: Date.now() - gone + total });

  it("says how many steps are used from half of them on, and before the last that it is the last, never changing what was sent", async () => {
    const events: string[] = [];
    const { options, conversation, messages } = setup(steps(4), { maxSteps: 4, budgetNotes: { begun: Date.now() }, count: (event) => events.push(event) });
    const sent: string[][] = [];
    const callModel = options.callModel;
    options.callModel = (history, signal, how) => (sent.push(history.map((m) => JSON.stringify(m))), callModel(history, signal, how));
    assert.equal((await runAgent(conversation, options)).stop, "max_steps");
    // None after the first step, nor after the last: no step follows it whose calls run.
    assert.deepEqual(notesIn(messages), ["", "(Note from jig: you have used 2 of your 4 steps.)", LAST_STEP, ""]);
    assert.deepEqual((messages[4].content as { type: string }[]).map((b) => b.type), ["tool_result", "text"], "the note follows the results, in their message");
    for (const [i, request] of sent.entries()) if (i > 0) assert.deepEqual(request.slice(0, sent[i - 1].length), sent[i - 1], "the cached prefix stays as it was");
    assert.deepEqual(events, ["budgetNote", "budgetNote.lastStep"]);
    // Off, nothing is said.
    const off = setup(steps(4), { maxSteps: 4 });
    await runAgent(off.conversation, off.options);
    assert.deepEqual(notesIn(off.messages), ["", "", "", ""]);
  });

  it("with --time-limit, says how much time is left too, from half of it on, whatever the steps", async () => {
    const minute = 60_000;
    const told = async (budgetNotes: AgentOptions["budgetNotes"]) => {
      const { options, conversation, messages } = setup([...steps(1), reply([text("Done.")])], { maxSteps: 50, budgetNotes });
      await runAgent(conversation, options);
      return notesIn(messages)[0];
    };
    assert.equal(await told(clock(20.5 * minute, 30 * minute)), "(Note from jig: you have used 1 of your 50 steps, with 9 of 30 minutes left.)");
    assert.equal(await told(clock(30 * minute - 30_900, 30 * minute)), "(Note from jig: you have used 1 of your 50 steps, with 30 seconds of 30 minutes left.)");
    assert.equal(await told(clock(39_100, minute)), "(Note from jig: you have used 1 of your 50 steps, with 20 of 60 seconds left.)");
    assert.equal(await told(clock(58_100, minute)), "(Note from jig: you have used 1 of your 50 steps, with 1 second of 60 seconds left.)");
    assert.equal(await told(clock(1_000, 30 * minute)), "", "less than half the time and the steps are used");
  });

  it("says nothing after a step the task was stopped in", async () => {
    const controller = new AbortController();
    const { options, conversation, messages } = setup([reply([toolUse("slow", "bash", { command: "sleep 30" })])], { maxSteps: 2, budgetNotes: { begun: Date.now() } });
    setTimeout(() => controller.abort("the time limit (--time-limit) was reached"), 100);
    assert.equal((await runAgent(conversation, options, controller.signal)).stop, "interrupted");
    assert.deepEqual(notesIn(messages), [""]);
  });
});

describe("looking at the trace before finishing (--finish-gate)", () => {
  const notices: string[] = [];
  const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
  beforeEach(() => {
    notices.length = 0;
  });
  const bash = (id: string, command: string) => toolUse(id, "bash", { command });
  const done = (t = "Done.") => reply([text(t)]);
  /** What the loop said to the model on its own, in order: the user's messages after the task. */
  const told = (messages: MessageParam[]) => messages.slice(1).flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : []));
  const changedAfterRun = "(Note from jig: you changed solve.sh after you last ran anything: run it, or its tests, before you finish.)";

  it("sends the model back once when it changed a file after it last ran anything, naming the file", async () => {
    const events: string[] = [];
    const { options, conversation, messages } = setup(
      [
        reply([toolUse("t1", "write_file", { path: "solve.sh", content: "echo 1\n" })]),
        reply([bash("t2", "sh solve.sh")]),
        reply([toolUse("t3", "edit_file", { path: "solve.sh", old_string: "1", new_string: "2" })]),
        done(),
        reply([bash("t4", "sh solve.sh")]),
        done("Done: it prints 2."),
      ],
      { finishGate: {}, count: (event) => events.push(event), ui },
    );
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.steps, result.text], ["end_turn", 6, "Done: it prints 2."]);
    assert.deepEqual(messages[8], { role: "user", content: changedAfterRun });
    assert.deepEqual(told(messages), [changedAfterRun], "once a task");
    assert.deepEqual(events, ["finishGate"]);
    assert.deepEqual(notices, ['Sending the model back once (--finish-gate): "you changed solve.sh after you last ran anything: run it, or its tests, before you finish."']);
  });

  it("stays quiet when something ran after the last change, and when it is off", async () => {
    const ran = setup([reply([toolUse("t1", "write_file", { path: "solve.sh", content: "echo 1\n" })]), reply([bash("t2", "sh solve.sh")]), done()], { finishGate: {} });
    assert.deepEqual(await runAgent(ran.conversation, ran.options).then((r) => [r.stop, r.steps]), ["end_turn", 3]);
    assert.deepEqual(told(ran.messages), []);
    const off = setup([reply([toolUse("t1", "write_file", { path: "solve.sh", content: "echo 1\n" })]), done()]);
    assert.deepEqual(await runAgent(off.conversation, off.options).then((r) => [r.stop, r.steps]), ["end_turn", 2]);
    assert.deepEqual(told(off.messages), []);
  });

  it("doesn't count commands that only look or change files as running anything, and says when nothing ran at all", async () => {
    const { options, conversation, messages } = setup(
      [
        reply([toolUse("t1", "write_file", { path: "./solve.sh", content: "echo 1\n" }), toolUse("t2", "write_file", { path: "lib.sh", content: "x=1\n" })]),
        reply([bash("t3", "cat solve.sh && ls -l | grep solve; sed -i 's/1/2/' lib.sh")]),
        done(),
        done("Still done."),
      ],
      { finishGate: {} },
    );
    await runAgent(conversation, options);
    assert.deepEqual(told(messages), ["(Note from jig: you changed solve.sh and lib.sh without running anything: run them, or their tests, before you finish.)"]);
  });

  it("names the files commands changed after the last run, by the snapshot's list and the files' times", async () => {
    await writeFile(join(cwd, "early.txt"), "changed before the run\n");
    const changed = () => ["early.txt", "gone.txt", "solve.sh"];
    const replies = [reply([bash("t1", "sh -c :")]), reply([bash("t2", "sleep 0.1; printf 'echo 2\\n' > solve.sh")]), done(), done("Ran it.")];
    const { options, conversation, messages } = setup(replies, { finishGate: { changed } });
    await runAgent(conversation, options);
    assert.deepEqual(told(messages), [changedAfterRun]);
    // With nothing run at all, every file the snapshot lists that is still there.
    const never = setup([done(), done("Ran it.")], { finishGate: { changed } });
    await runAgent(never.conversation, never.options);
    assert.deepEqual(told(never.messages), ["(Note from jig: you changed early.txt and solve.sh without running anything: run them, or their tests, before you finish.)"]);
  });

  it("sends the model back when its last test run failed, and not once a later one passed", async () => {
    const failed = setup([reply([bash("t1", "false && pytest")]), done(), done("It can't pass: pytest isn't installed.")], { finishGate: {} });
    await runAgent(failed.conversation, failed.options);
    assert.deepEqual(told(failed.messages), ["(Note from jig: your last test run failed (`false && pytest`): fix what it reports, or say why it can't pass, before you finish.)"]);
    const passed = setup([reply([bash("t1", "false && pytest")]), reply([bash("t2", "true || pytest")]), done()], { finishGate: {} });
    await runAgent(passed.conversation, passed.options);
    assert.deepEqual(told(passed.messages), []);
  });

  it("looks only at the first stop with a step left, before --check", async () => {
    // Each run writes a file of its own: they share the project, and write_file won't overwrite one unread.
    const write = (path: string) => reply([toolUse("t1", "write_file", { path, content: "echo 1\n" })]);
    const REVIEW = "Check your work.";
    const both = setup([write("solve.sh"), done(), done("Ran it."), done("Checked.")], { finishGate: {}, review: REVIEW });
    assert.equal((await runAgent(both.conversation, both.options)).text, "Checked.");
    assert.deepEqual(told(both.messages), ["(Note from jig: you changed solve.sh without running anything: run it, or its tests, before you finish.)", REVIEW]);
    // Nothing to say at the first stop: --check asks there, and a change after it isn't looked at.
    const later = setup([done(), write("later.sh"), done("Changed it.")], { finishGate: {}, review: REVIEW });
    assert.equal((await runAgent(later.conversation, later.options)).text, "Changed it.");
    assert.deepEqual(told(later.messages), [REVIEW]);
    assert.ok(existsSync(join(cwd, "later.sh")));
    // On the last step, the answer stands.
    const last = setup([write("last.sh"), done()], { finishGate: {}, maxSteps: 2 });
    assert.deepEqual(await runAgent(last.conversation, last.options).then((r) => [r.stop, r.text]), ["end_turn", "Done."]);
    assert.deepEqual(told(last.messages), []);
    assert.ok(existsSync(join(cwd, "last.sh")));
  });

  it("doesn't look too close to the time limit, then or at a later stop, and counts that", async () => {
    const events: string[] = [];
    const write = (path: string) => reply([toolUse("t1", "write_file", { path, content: "echo 1\n" })]);
    const verdicts = ["tests fail", null];
    const late = setup([write("late.sh"), done(), done("Fixed.")], { finishGate: {}, checkUntil: 0, stopHooks: async () => verdicts.shift()!, count: (event) => events.push(event) });
    const result = await runAgent(late.conversation, late.options);
    assert.deepEqual([result.stop, result.steps, result.text], ["end_turn", 3, "Fixed."]);
    assert.ok(!told(late.messages).some((message) => message.startsWith("(Note from jig")));
    assert.deepEqual(events, ["finishGate.skipped", "hook.stopBlocked"]);
    // With time left, it looks as before.
    const early = setup([write("early.sh"), done(), done("Ran it.")], { finishGate: {}, checkUntil: Date.now() + 60_000 });
    await runAgent(early.conversation, early.options);
    assert.deepEqual(told(early.messages), ["(Note from jig: you changed early.sh without running anything: run it, or its tests, before you finish.)"]);
  });

  it("tells a command that runs something from one that only looks at files or changes them", () => {
    const runs = [
      ...["sh solve.sh", "python3 solve.py", "./a.out < input.txt", "cd app && npm test", "cat in.txt | node main.js", "FOO=1 make", "echo $(python3 -c 'print(1)')"],
      ...["for f in *.py; do python3 $f; done", "timeout 5 ./server", "if true; then ./check; fi"],
      // A substitution in double quotes runs too.
      'echo "Result: $(python3 solve.py)"',
      'out="$(python3 solve.py)"; echo "$out"',
      '[ "$(python3 solve.py)" = "42" ] && echo PASS || echo FAIL',
      'test "$(./solve 3)" = 6 && echo ok',
      'echo "status: $(curl -s localhost:8080/health)"',
      'echo "`python3 solve.py`"',
      'echo "$(python3 "solve.py")"',
    ];
    const doesnt = [
      'echo "lines: $(wc -l < solve.py)"',
      'echo "x; ./solve" "total: $((1 + 2))"',
      "cat solve.py",
      "ls -la && grep -rn TODO .",
      "sed -n 1,20p a.py; head -5 b.py",
      "mkdir -p out && cp a.txt out/ && mv out/a.txt out/b.txt",
      "cat > solve.py << 'EOF'\nimport os\nos.system('make')\nEOF",
      "cat <<EOF > run.sh\n./build\nEOF\nchmod +x run.sh",
      "/bin/rm -f x.txt",
      "git diff --stat && git status",
      "echo done > status.txt",
      "for f in *.txt; do wc -l $f; done",
    ];
    assert.deepEqual(runs.filter((command) => !runsSomething(command)), []);
    assert.deepEqual(doesnt.filter(runsSomething), []);
  });
});

describe("counting the loop's mechanisms (--stats)", () => {
  /** The mechanisms a run counted, in order. */
  async function counted(replies: ModelTurn[], overrides: Partial<AgentOptions> = {}): Promise<string[]> {
    const events: string[] = [];
    const { options, conversation } = setup(replies, { count: (event) => events.push(event), ...overrides });
    await runAgent(conversation, options);
    return events;
  }
  const bash = (id: string, command: string) => toolUse(id, "bash", { command });
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };

  it("counts each one as it fires, and nothing in a run that needs none", async () => {
    assert.deepEqual(await counted([reply([bash("t1", "true")]), reply([text("Done.")])]), []);
    assert.deepEqual(await counted([reply([]), reply([text("Done.")])]), ["reply.empty"]);
    assert.deepEqual(await counted([reply([text("The plan: ")], "max_tokens"), reply([text("done.")])]), ["reply.continued"]);
    assert.deepEqual(await counted([reply([text("Sure, here is")], "refusal")]), ["reply.refused"]);
    assert.deepEqual(await counted([reply([bash("t1", "true")]), reply([text("Done.")])], { compactAt: 50 }), ["compaction"]);
    assert.deepEqual(await counted([reply([text("Done.")]), reply([text("Checked.")])], { review: "Check your work." }), ["check"]);
    const reviewer: Reviewer = { model: "strong", review: async () => ({ verdict: "problems", feedback: "PROBLEMS: out.txt is missing.", usage }) };
    assert.deepEqual(await counted([reply([text("Done.")]), reply([text("Fixed.")])], { reviewer }), ["review", "review.problems"]);
    assert.deepEqual(await counted([reply([text("Done.")])], { review: "Check your work.", checkUntil: Date.now() }), ["check.skipped"]);
    assert.deepEqual(await counted([reply([text("Done.")])], { reviewer, checkUntil: Date.now() }), ["review.skipped"]);
    const escalate = { model: "strong", callModel: async () => reply([text("Fixed it.")]) };
    assert.deepEqual(await counted([reply([bash("t1", "false && pytest")])], { maxSteps: 4, escalate }), ["escalated"]);
    const forever = Array.from({ length: 3 }, (_, i) => reply([bash(`t${i}`, `echo ${i}`)]));
    assert.deepEqual(await counted(forever, { maxSteps: 2, wrapUp: true }), ["wrapUp"]);
    const again = Array.from({ length: 6 }, (_, i) => reply([toolUse(`t${i}`, "read_file", { path: "missing.txt" })]));
    assert.deepEqual(await counted(again), ["loop"]);
    const verdicts = ["tests fail", null];
    assert.deepEqual(await counted([reply([text("Done.")]), reply([text("Fixed.")])], { stopHooks: async () => verdicts.shift()! }), ["hook.stopBlocked"]);
  });

  it("counts the calls that didn't run as asked, and the hooks' say", async () => {
    const hooks = {
      before: async (_tool: string, input: Record<string, unknown>) => (String(input.command).startsWith("rm") ? "no deleting" : null),
      after: async () => "lint: fine",
    };
    const calls = reply([
      bash("a", "echo one"), // runs, and the after-hook reports on it
      bash("b", "echo one"), // a repeat of a
      toolUse("c", "teleport", {}),
      toolUse("d", "write_file", { path: "x.txt" }), // no content
      bash("e", "rm -rf build"), // blocked by the hook
    ]);
    assert.deepEqual(await counted([calls, reply([text("Done.")])], { hooks }), ["hook.feedback", "call.repeat", "call.notOffered", "call.invalid", "hook.blocked"]);
    const plan = { authorize: async () => "Refused: plan mode is on, so nothing may be changed." };
    assert.deepEqual(await counted([reply([toolUse("t1", "write_file", { path: "x.txt", content: "x" })]), reply([text("ok")])], plan), ["call.refused"]);
    assert.deepEqual(await counted([reply([toolUse("t1", "write_file", { path: "half.txt", content: "tru" })], "max_tokens"), reply([text("ok")])]), ["call.cutOff"]);
    assert.deepEqual(await counted([reply([bash("t1", "seq 100000")]), reply([text("ok")])]), ["output.truncated"]);
  });

  it("stops a model repeating a command whose long output goes to a new file each time", async () => {
    const outputs = new OutputFiles();
    try {
      const again = Array.from({ length: SAME_STEPS + 1 }, (_, i) => reply([bash(`t${i}`, "seq 1 20000")]));
      assert.deepEqual(await counted(again, { outputs }), [...Array(SAME_STEPS).fill("output.truncated"), "loop"]);
    } finally {
      outputs.remove();
    }
  });

  it("answers the call even when counting what it did fails", async () => {
    const count = () => {
      throw new Error("the stats file can't be written");
    };
    const { options, conversation } = setup([reply([bash("t1", "seq 100000")]), reply([text("Done.")])], { count });
    assert.equal((await runAgent(conversation, options)).text, "Done.");
    const results = conversation.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result");
    assert.equal(results.length, 1);
    assert.match(JSON.stringify(results[0]), /the stats file can't be written/);
  });
});
