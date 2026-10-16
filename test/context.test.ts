import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentOptions } from "../src/agent.ts";
import { compact } from "../src/compact.ts";
import { Conversation } from "../src/conversation.ts";
import { loadMemories } from "../src/memory.ts";
import type { CallModel, ModelTurn } from "../src/model.ts";
import { projectKey } from "../src/paths.ts";
import { loadInstructions, systemPrompt } from "../src/prompt.ts";
import { SessionFile } from "../src/session.ts";
import { Snapshots } from "../src/snapshots.ts";
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

  it("forgets which files were read, so they are read again before editing", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "hi" }]);
    await writeFile(join(dir, "a.txt"), "x");
    await conversation.versions.record(join(dir, "a.txt"));
    await compact(conversation, fakeModel([]));
    await assert.rejects(conversation.versions.assertCurrent(join(dir, "a.txt"), "a.txt"), /haven't read/);
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

describe("a project's directories in jig's home", () => {
  // Before, a project's key was its path with / replaced by -, and nothing else.
  const oldKey = (path: string) => path.replace(/[\\/:]/g, "-");
  const start = (cwd: string) => `${JSON.stringify({ type: "start", cwd, model: "m", date: "" })}\n`;

  it("differ for paths that read alike once / is -, and a symlink shares its target's", async () => {
    await mkdir(join(dir, "my-app"));
    await mkdir(join(dir, "my", "app"), { recursive: true });
    await symlink(join(dir, "my-app"), join(dir, "link"));
    assert.notEqual(projectKey(join(dir, "my-app")), projectKey(join(dir, "my", "app")));
    assert.equal(projectKey(join(dir, "link")), projectKey(join(dir, "my-app")));
    assert.match(projectKey(join(dir, "my-app")), /-my-app-[0-9a-f]{8}$/, "the path is still there to read");
    assert.ok(SessionFile.create(join(dir, "link"), "m").path.startsWith(join(dir, "home", "sessions", projectKey(join(dir, "my-app")))));
  });

  it("take over the sessions, memories and snapshots kept under the old key", async () => {
    const project = join(dir, "my-app");
    await mkdir(project);
    const old = (store: string, path = project) => join(dir, "home", store, oldKey(path));
    await mkdir(old("sessions"), { recursive: true });
    await writeFile(join(old("sessions"), "2026-10-01T10-00-00-abcd.jsonl"), start(project));
    const memories = old(join("memory", "project"), await realpath(project)); // memory went by the real path already
    await mkdir(memories, { recursive: true });
    await writeFile(join(memories, "make-check.md"), "---\nname: make-check\ndescription: Tests run with make check\n---\n");
    await mkdir(old("snapshots"), { recursive: true });
    await writeFile(join(old("snapshots"), "HEAD"), "ref: refs/heads/master\n");

    assert.deepEqual(SessionFile.list(project).map((file) => basename(file)), ["2026-10-01T10-00-00-abcd.jsonl"]);
    assert.deepEqual(loadMemories(project).map((memory) => memory.name), ["make-check"]);
    new Snapshots(project);
    assert.ok(existsSync(join(dir, "home", "snapshots", projectKey(project), "HEAD")));
    for (const moved of [old("sessions"), memories, old("snapshots")]) assert.equal(existsSync(moved), false, moved);
    assert.equal(SessionFile.list(project).length, 1, "and only once");
  });

  it("put together the sessions saved through a symlink and through its target", async () => {
    const project = await realpath(await mkdtemp(join(dir, "real-")));
    const link = join(dir, "link");
    await symlink(project, link);
    for (const [path, name] of [[link, "a.jsonl"], [project, "b.jsonl"]]) {
      await mkdir(join(dir, "home", "sessions", oldKey(path)), { recursive: true });
      await writeFile(join(dir, "home", "sessions", oldKey(path), name), start(path));
    }
    assert.deepEqual(SessionFile.list(link).map((file) => basename(file)), ["a.jsonl", "b.jsonl"]);
  });

  it("leave what two projects shared under the old key where it is", async () => {
    const [mine, other] = [join(dir, "my-app"), join(dir, "my", "app")];
    await mkdir(mine);
    await mkdir(other, { recursive: true });
    const shared = join(dir, "home", "sessions", oldKey(mine));
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "a.jsonl"), start(mine));
    await writeFile(join(shared, "b.jsonl"), start(other));
    assert.deepEqual(SessionFile.list(mine), []);
    assert.deepEqual(SessionFile.list(other), []);
    assert.ok(existsSync(join(shared, "a.jsonl")) && existsSync(join(shared, "b.jsonl")));
  });

  it("move together, so a project whose path reads alike can't take what the sessions leave behind", async () => {
    const base = await realpath(dir);
    const [mine, other] = [join(base, "my-app"), join(base, "my", "app")];
    await mkdir(mine);
    await mkdir(other, { recursive: true });
    const old = (store: string) => join(dir, "home", store, oldKey(mine));
    await mkdir(old("sessions"), { recursive: true });
    await writeFile(join(old("sessions"), "a.jsonl"), start(mine));
    await mkdir(old(join("memory", "project")), { recursive: true });
    await writeFile(join(old(join("memory", "project")), "deploy-key.md"), "---\nname: deploy-key\ndescription: Deploys use the key in the vault\n---\n");
    await mkdir(old("snapshots"), { recursive: true });
    await writeFile(join(old("snapshots"), "HEAD"), "ref: refs/heads/master\n");

    assert.deepEqual(loadMemories(other), [], "the session says whose they are");
    assert.equal(SessionFile.list(mine).length, 1); // jig --sessions, say, which asks for nothing else
    assert.deepEqual(loadMemories(other), []);
    new Snapshots(other);
    assert.equal(existsSync(join(dir, "home", "snapshots", projectKey(other))), false);
    assert.deepEqual(loadMemories(mine).map((memory) => memory.name), ["deploy-key"]);
    assert.ok(existsSync(join(dir, "home", "snapshots", projectKey(mine), "HEAD")));
  });

  it("leave what no session says was the project's where it is", async () => {
    const project = await realpath(await mkdtemp(join(dir, "real-")));
    const memories = join(dir, "home", "memory", "project", oldKey(project));
    await mkdir(memories, { recursive: true });
    await writeFile(join(memories, "make-check.md"), "---\nname: make-check\ndescription: Tests run with make check\n---\n");
    assert.deepEqual(loadMemories(project), []);
    assert.ok(existsSync(join(memories, "make-check.md")));
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
