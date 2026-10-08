import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentOptions } from "../src/agent.ts";
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
