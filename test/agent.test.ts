import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { failedTestRun, runAgent, WRAP_UP, type AgentOptions, type Reviewer, type ReviewVerdict } from "../src/agent.ts";
import { Conversation } from "../src/conversation.ts";
import type { CallModel, ModelTurn } from "../src/model.ts";
import { toChatMessages } from "../src/openai.ts";
import { TOOLS, type Tool } from "../src/tools/index.ts";

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

  it("doesn't ask on the last step, where no step is left to check: the answer stands", async () => {
    const { options, conversation, messages } = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([text("All done.")])], { review: REVIEW, maxSteps: 2 });
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "All done.", 2]);
    assert.equal(messages.at(-1)?.role, "assistant", "the session ends on the answer, not on an unanswered request");
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

  it("ends the run on a second empty reply, or one at the last step, with a valid history", async () => {
    const notices: string[] = [];
    const twice = setup([reply([toolUse("t1", "bash", { command: "true" })]), reply([]), reply([text(" \n")])], {
      ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) },
    });
    const result = await runAgent(twice.conversation, twice.options);
    assert.deepEqual([result.stop, result.text.trim(), result.steps], ["end_turn", "", 3]);
    assert.deepEqual(twice.messages.map((m) => m.role), ["user", "assistant", "user", "user"]);
    assert.equal(notices.at(-1), "The model replied without text or a tool call, so the task ends without an answer.");
    // Every assistant message holds something to send back, in either API's format.
    assert.ok(twice.messages.every((m) => m.role === "user" || (m.content as Block[]).some((b) => b.type === "tool_use" || (b.type === "text" && b.text.trim()))));
    assert.ok(toChatMessages("", twice.messages).every((m) => m.role !== "assistant" || m.content || m.tool_calls));
    const last = setup([reply([])], { maxSteps: 1 });
    assert.deepEqual(await runAgent(last.conversation, last.options).then((r) => [r.stop, r.steps]), ["end_turn", 1]);
    assert.equal(last.messages.length, 1);
  });

  it("handles a reply with only thinking like an empty one", async () => {
    const { options, conversation, messages } = setup([reply([thinking("It is done.")]), reply([thinking("So"), text("Done.")])]);
    const result = await runAgent(conversation, options);
    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "Done.", 2]);
    assert.deepEqual(messages.map((m) => m.role), ["user", "user", "assistant"]);
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
    const last = fakeReviewer("problems");
    const lastStep = setup([reply([text("Done.")])], { reviewer: last.reviewer, maxSteps: 1 });
    assert.equal((await runAgent(lastStep.conversation, lastStep.options)).text, "Done.");
    assert.equal(last.seen.length, 0);
  });
});
