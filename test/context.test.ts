import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { runAgent, type AgentOptions } from "../src/agent.ts";
import { compact } from "../src/compact.ts";
import { Conversation } from "../src/conversation.ts";
import { type CallModel, type ModelTurn, tooLong } from "../src/model.ts";
import { loadInstructions, systemPrompt } from "../src/prompt.ts";
import { SessionFile } from "../src/session.ts";
import { TOOLS } from "../src/tools/index.ts";

type Block = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;
const reply = (content: Block[], inputTokens = 100): ModelTurn => ({
  message: {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: 10 },
  } as Anthropic.Beta.BetaMessage,
  malformed: new Map(),
});

/** A fake model: summary requests get a summary, everything else the next scripted reply. */
function fakeModel(replies: ModelTurn[], summaries: MessageParam[][] = []): CallModel {
  return async (messages, _signal, options) => {
    if (options?.summarize) {
      summaries.push(messages);
      return reply([text("SUMMARY: fixed the parser, tests pass.")]);
    }
    const next = replies.shift();
    if (!next) throw new Error("the fake model ran out of replies");
    return next;
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jig-context-"));
  process.env.JIG_HOME = join(dir, "home");
});

const options = (callModel: CallModel, compactAt: number): AgentOptions => ({
  callModel,
  tools: TOOLS,
  cwd: dir,
  maxSteps: 10,
  compactAt,
  authorize: async () => null,
  ui: { toolCall() {}, toolResult() {}, notice() {} },
});

describe("compaction", () => {
  it("summarizes the history but keeps a new request word for word", async () => {
    const conversation = new Conversation(undefined, [
      { role: "user", content: "fix the parser" },
      { role: "assistant", content: [text("Done.")] },
      { role: "user", content: "now add a test" },
    ]);
    conversation.tokens = 9000;
    const summaries: MessageParam[][] = [];
    await runAgent(conversation, options(fakeModel([reply([text("Added.")])], summaries), 5000));

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].length, 3, "the summary request has the history and the request for a summary");
    assert.equal(summaries[0][1].role, "assistant");
    const [summary, request, answer] = conversation.messages;
    assert.match(String(summary.content), /compacted.*SUMMARY: fixed the parser/s);
    assert.doesNotMatch(String(summary.content), /Continue the task/);
    assert.deepEqual(request, { role: "user", content: "now add a test" });
    assert.equal(answer.role, "assistant");
  });

  it("carries on mid-task once the conversation grows past the limit", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "do it" }]);
    const model = fakeModel([reply([toolUse("t1", "bash", { command: "echo hi" })], 4000), reply([text("Done.")])]);
    const result = await runAgent(conversation, options(model, 1000));

    assert.equal(result.stop, "end_turn");
    assert.equal(conversation.messages.length, 2);
    assert.match(String(conversation.messages[0].content), /SUMMARY.*Continue the task from where it stopped/s);
    assert.equal(result.usage.output, 30, "the summary call is counted too");
  });

  it("doesn't end the task when the summary fails: it goes on as it is and compacts again a few steps later", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "do it" }]);
    const replies = [1, 2, 3, 4].map((i) => reply([toolUse(`t${i}`, "bash", { command: `echo ${i}` })], 4000));
    let calls = 0;
    const summarizedAfter: number[] = [];
    const callModel: CallModel = async (_messages, _signal, options) => {
      if (options?.summarize) {
        summarizedAfter.push(calls);
        // The first summary comes back empty; the next one is fine.
        return reply(summarizedAfter.length === 1 ? [] : [text("SUMMARY: echoed 1 to 4.")]);
      }
      calls++;
      return replies.shift() ?? reply([text("Done.")]);
    };
    const notices: string[] = [];
    const events: string[] = [];
    const result = await runAgent(conversation, { ...options(callModel, 1000), ui: { toolCall() {}, toolResult() {}, notice: (n) => notices.push(n) }, count: (event) => events.push(event) });

    assert.deepEqual([result.stop, result.text], ["end_turn", "Done."]);
    assert.deepEqual(summarizedAfter, [1, 4], "tried before step 2, then again before step 5");
    assert.deepEqual(events, ["compaction.failed", "compaction"]);
    assert.ok(notices.includes("Compaction failed (the model wrote no summary), so the conversation goes on as it is; compacting again from step 5."), notices.join("\n"));
    assert.equal(conversation.messages.length, 2);
    assert.match(String(conversation.messages[0].content), /SUMMARY: echoed 1 to 4\./);
  });

  it("restates the task word for word after a summary mid-task, with what was done for it", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "<skill>Be brief.</skill>\n\nrename foo to bar" }]);
    conversation.pin("skill:brief", "<skill>Be brief.</skill>");
    const model = fakeModel([reply([toolUse("t1", "bash", { command: "echo renamed" })], 4000), reply([toolUse("t2", "bash", { command: "echo again" })], 4000), reply([text("Done.")])]);
    await runAgent(conversation, options(model, 1000));

    const summary = String(conversation.messages[0].content);
    assert.match(summary, /SUMMARY: fixed the parser, tests pass\.\n\nThe task you are working on, word for word:\n\n\[this part follows word for word below, under "Still in effect from before the summary"\]\n\nrename foo to bar\n\n/);
    // Twice compacted: the log still has the command from before the first summary.
    assert.match(summary, /What you did for it before the summary, from your tool calls[^\n]*:\n\n\$ echo renamed\n {2}→ exit 0, last line: renamed\n\$ echo again\n {2}→ exit 0, last line: again\n\nStill in effect from before the summary:\n\n<skill>Be brief\.<\/skill>\n\nContinue the task from where it stopped\.$/);
    assert.equal(summary.split("<skill>").length, 2, "a skill's instructions the task holds are kept once");
  });

  it("restates the user's words even with a large skill, and a long task's start and end", async () => {
    const summaryAfterOneStep = async (task: string, skill?: string) => {
      const conversation = new Conversation(undefined, [{ role: "user", content: task }]);
      if (skill) conversation.pin("skill:big", skill);
      await runAgent(conversation, options(fakeModel([reply([toolUse("t1", "bash", { command: "echo hi" })], 4000), reply([text("Done.")])]), 1000));
      return String(conversation.messages[0].content);
    };
    // A /<skill> task whose skill alone is longer than the restatement may be: the skill is kept once, and
    // the request after it is still there.
    const skill = `<skill_content name="big">\n${"Keep each slide to one idea.\n".repeat(1000)}</skill_content>`;
    const withSkill = await summaryAfterOneStep(`${skill}\n\nfix the parser in src/parse.ts`, skill);
    assert.equal(withSkill.split(skill).length, 2, "the skill is there once");
    assert.equal(withSkill.split("fix the parser in src/parse.ts").length, 2, "and so are the user's words");
    assert.doesNotMatch(withSkill, /left out/);

    // A long piped task keeps its start and its end, where the ask often is.
    const piped = `Here is the build log:\n${"x".repeat(30_000)}\nFix what made it fail.`;
    const summary = await summaryAfterOneStep(piped);
    assert.match(summary, new RegExp(`word for word:\\n\\nHere is the build log:\\nx+\\n\\[… ${piped.length - 20_000} characters of the task left out …\\]\\nx+\\nFix what made it fail\\.\\n\\n`));
    assert.ok(summary.length < 21_000, "and no more than 20,000 characters of it");
  });

  it("forgets which files were read, so they are read again before editing", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "hi" }]);
    await writeFile(join(dir, "a.txt"), "x");
    await conversation.versions.record(join(dir, "a.txt"));
    await compact(conversation, fakeModel([]));
    await assert.rejects(conversation.versions.assertCurrent(join(dir, "a.txt"), "a.txt"), /haven't read/);
  });
});

/** An error as each SDK makes it of an API's error response. */
const anthropicError = (status: number, message: string) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message } }, undefined, new Headers());
const openaiError = (status: number, message: string, code: string | null = null) =>
  OpenAI.APIError.generate(status, { error: { message, type: "invalid_request_error", code, param: null } }, undefined, new Headers());
const TOO_LONG = anthropicError(400, "prompt is too long: 40312 tokens > 32768 maximum");

describe("a conversation too long for the model", () => {
  /** A finished task whose tool result is long, then a new request; and a model that sees it all. */
  function setup(answer: (call: number) => ModelTurn) {
    const output = `first line\n${"x".repeat(20_000)}\nlast line`;
    const result = { type: "tool_result" as const, tool_use_id: "t1", content: output };
    const conversation = new Conversation(undefined, [
      { role: "user", content: "show me the log" },
      { role: "assistant", content: [toolUse("t1", "bash", { command: "cat build.log" })] },
      { role: "user", content: [result] },
      { role: "assistant", content: [text("It failed at the link step.")] },
      { role: "user", content: "fix the link step" },
    ]);
    const summaries: MessageParam[][] = [];
    let calls = 0;
    const callModel: CallModel = async (messages, _signal, options) => {
      if (options?.summarize) {
        summaries.push(messages);
        return reply([text("SUMMARY: the build fails at the link step.")]);
      }
      return answer(++calls);
    };
    const notices: string[] = [];
    const events: string[] = [];
    const ui = { toolCall() {}, toolResult() {}, notice: (n: string) => notices.push(n) };
    const run = (compactAt = 1_000_000) => runAgent(conversation, { ...options(callModel, compactAt), ui, count: (event) => events.push(event) });
    return { conversation, output, result, summaries, notices, events, run };
  }

  it("compacts when the API rejects a request as too long, and asks again", async () => {
    const { conversation, output, result: stored, summaries, notices, events, run } = setup((call) => {
      if (call === 1) throw TOO_LONG;
      return reply([text("Fixed.")]);
    });
    const result = await run();

    assert.deepEqual([result.stop, result.text, result.steps], ["end_turn", "Fixed.", 1]);
    assert.ok(notices.some((n) => /too long for the model; compacting it and asking again/.test(n)), notices.join("\n"));
    assert.deepEqual(events, ["compaction.tooLong", "compaction"]);
    // The summary was written from a copy with the tool output cut to its start and end...
    assert.equal(summaries.length, 1);
    const sent = (summaries[0][2].content as { content: string }[])[0].content;
    assert.match(sent, /^first line\nx+\n\[… 19\d\d\d characters cut to fit the summary request …\]\nx+\nlast line$/);
    assert.ok(sent.length < 1500);
    // ...while the history itself was replaced, not edited.
    assert.equal(stored.content, output);
    const [summary, request, answer] = conversation.messages;
    assert.match(String(summary.content), /SUMMARY: the build fails/);
    assert.deepEqual(request, { role: "user", content: "fix the link step" });
    assert.equal(answer.role, "assistant");
  });

  it("asks again only once, and not at all for other errors or with compaction off", async () => {
    const twice = setup(() => {
      throw TOO_LONG;
    });
    await assert.rejects(twice.run(), /prompt is too long/);
    assert.equal(twice.summaries.length, 1);

    const other = setup(() => {
      throw anthropicError(400, "messages.3.content: text content blocks must be non-empty");
    });
    await assert.rejects(other.run(), /must be non-empty/);
    assert.equal(other.summaries.length, 0);

    const off = setup(() => {
      throw TOO_LONG;
    });
    await assert.rejects(off.run(0), /prompt is too long/);
    assert.equal(off.summaries.length, 0);
  });

  it("tells the APIs' 'too long' from their other errors", () => {
    const overflows = [
      TOO_LONG,
      anthropicError(400, "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000, decrease input length or `max_tokens` and try again"),
      openaiError(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 135201 tokens. Please reduce the length of the messages.", "context_length_exceeded"),
      openaiError(400, "Your input exceeds the context window of this model. Please adjust your input and try again.", "context_length_exceeded"),
      openaiError(400, "This model's maximum context length is 131072 tokens. However, you requested 140102 tokens (140102 in the messages, 0 in the completion). Please reduce the length of the messages or completion."),
      openaiError(400, "The decoder prompt (length 40211) is longer than the maximum model length of 32768. Make sure that `max_model_len` is no smaller than the number of text tokens."),
      openaiError(400, "prompt too long; exceeded max context length by 2210 tokens"),
      openaiError(400, "request (40211 tokens) exceeds the available context size (32768 tokens), try increasing it"),
    ];
    const others = [
      openaiError(429, "Rate limit reached for gpt-5 in organization org-abc on tokens per min (TPM): Limit 30000, Used 28000, Requested 4000. Please try again in 4s.", "rate_limit_exceeded"),
      openaiError(429, "Request too large for gpt-5 in organization org-abc on tokens per min (TPM): Limit 30000, Requested 45000. The input or output tokens must be reduced in order to run successfully.", "rate_limit_exceeded"),
      anthropicError(429, "This request would exceed the rate limit for your organization of 40,000 input tokens per minute."),
      anthropicError(413, "Request exceeds the maximum allowed number of bytes."),
      anthropicError(400, "max_tokens: 100000 > 64000, which is the maximum allowed number of output tokens for claude-opus-5-5"),
      anthropicError(400, "messages.3.content: text content blocks must be non-empty"),
      new Error("prompt is too long"), // not the API's
    ];
    assert.deepEqual(overflows.filter((err) => !tooLong(err)), []);
    assert.deepEqual(others.filter(tooLong), []);
  });

  it("summarizes from a shortened copy when the summary request itself is too long (/compact)", async () => {
    const conversation = new Conversation(undefined, [
      { role: "user", content: "show me the log" },
      { role: "assistant", content: [toolUse("t1", "bash", { command: "cat build.log" })] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(20_000) }] },
    ]);
    const sizes: number[] = [];
    const callModel: CallModel = async (messages) => {
      sizes.push(JSON.stringify(messages).length);
      if (JSON.stringify(messages).length > 10_000) throw openaiError(400, "This model's maximum context length is 4096 tokens. However, you requested 5402 tokens (5402 in the messages, 0 in the completion). Please reduce the length of the messages or completion.");
      return reply([text("SUMMARY: a long log.")]);
    };
    const compacted = await compact(conversation, callModel);
    assert.equal(sizes.length, 2, "the whole history first, then a copy with its tool output cut");
    assert.equal(compacted?.cut, 1);
    assert.match(String(conversation.messages[0].content), /SUMMARY: a long log/);
  });
});

describe("sessions", () => {
  it("saves every message and replays compactions when loading", async () => {
    const session = SessionFile.create(dir, "fake-model");
    const conversation = new Conversation(session);
    conversation.push({ role: "user", content: "first task" });
    conversation.push({ role: "assistant", content: [text("ok")] });
    await compact(conversation, fakeModel([]));
    conversation.push({ role: "user", content: "second task" });

    const loaded = SessionFile.load(session.path);
    assert.equal(loaded.length, 2);
    assert.match(String(loaded[0].content), /SUMMARY/);
    assert.deepEqual(loaded[1], { role: "user", content: "second task" });
    assert.deepEqual(SessionFile.list(dir), [session.path]);
    assert.equal(SessionFile.firstRequest(session.path), "first task");
  });

  it("records when each message was written, and how long its model call or its tool calls took", async () => {
    const session = SessionFile.create(dir, "fake-model");
    const conversation = new Conversation(session, []);
    const began = Date.now(); // before the task's message, the first line it checks
    conversation.push({ role: "user", content: "do it" });
    const replies = [reply([toolUse("t1", "bash", { command: "sleep 0.3" }), toolUse("t2", "bash", { command: "true" })]), reply([text("Done.")])];
    const slow: CallModel = async () => {
      await new Promise((done) => setTimeout(done, 100));
      return replies.shift()!;
    };
    await runAgent(conversation, options(slow, 0));

    const [start, ...entries] = (await readFile(session.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(start.type, "start");
    const times = entries.map((entry) => Date.parse(entry.at));
    assert.ok(times.every((time, i) => time >= (times[i - 1] ?? began) && time <= Date.now()), JSON.stringify(entries.map((entry) => entry.at)));
    const [task, call, results, answer] = entries;
    assert.deepEqual([task.ms, task.toolMs], [undefined, undefined], "the user's message took no step");
    assert.ok(call.ms >= 90 && answer.ms >= 90, `the model calls took ${call.ms} and ${answer.ms} ms`);
    assert.deepEqual(Object.keys(results.toolMs), ["t1", "t2"]);
    assert.ok(results.toolMs.t1 >= 250 && results.toolMs.t2 < results.toolMs.t1, JSON.stringify(results.toolMs));
    assert.deepEqual(SessionFile.load(session.path), conversation.messages, "the timing stays out of the messages");
  });

  it("writes nothing until there is a message", () => {
    SessionFile.create(dir, "fake-model");
    assert.deepEqual(SessionFile.list(dir), []);
  });

  it("answers tool calls a crash left open, and skips a half-written line", async () => {
    const path = join(dir, "crashed.jsonl");
    const lines = [
      { type: "start", cwd: dir, model: "m", date: "" },
      { type: "message", message: { role: "user", content: "go" } },
      { type: "message", message: { role: "assistant", content: [toolUse("t9", "bash", { command: "make" })] } },
    ];
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{"type":"mess`);
    const loaded = SessionFile.load(path);
    assert.equal(loaded.length, 3);
    assert.deepEqual(loaded[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t9", content: "Not run: the session ended before this call ran.", is_error: true }],
    });
  });
});

describe("AGENTS.md", () => {
  it("loads instructions from the repository root down to the working directory", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await mkdir(join(dir, "service"));
    await writeFile(join(dir, "AGENTS.md"), "Use tabs.");
    await writeFile(join(dir, "service", "CLAUDE.md"), "Run `make test` before you finish.");
    const instructions = loadInstructions(join(dir, "service"));
    assert.deepEqual(instructions, [
      { path: "../AGENTS.md", text: "Use tabs." },
      { path: "CLAUDE.md", text: "Run `make test` before you finish." },
    ]);
    const prompt = systemPrompt(join(dir, "service"), { instructions });
    assert.match(prompt, /<instructions file="\.\.\/AGENTS\.md">\nUse tabs\.\n<\/instructions>/);
    assert.ok(prompt.indexOf("Use tabs") < prompt.indexOf("make test"), "the more specific file comes last");
  });

  it("prefers AGENTS.md to CLAUDE.md, and finds nothing outside a project", async () => {
    await writeFile(join(dir, "AGENTS.md"), "agents");
    await writeFile(join(dir, "CLAUDE.md"), "claude");
    assert.deepEqual(loadInstructions(dir).map((i) => i.text), ["agents"]);
    assert.equal(systemPrompt(dir).includes("<instructions"), false);
    assert.ok((await readFile(join(dir, "AGENTS.md"), "utf8")).length > 0);
  });
});
