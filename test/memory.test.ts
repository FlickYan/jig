import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../src/agent.ts";
import { Conversation } from "../src/conversation.ts";
import { proposeInstructionsTool } from "../src/instructions-proposals.ts";
import { loadMemories, memoryDir, memoryPrompt, memoryTool, proposeMemoryTool } from "../src/memory.ts";
import type { CallModel } from "../src/model.ts";
import { Permissions } from "../src/permissions.ts";
import type { Approve } from "../src/proposals.ts";
import { findSecret } from "../src/secrets.ts";
import { FileVersions } from "../src/tools/util.ts";
import { fakeMessagesApi, runJig, systemText } from "./fake-api.ts";

let project: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "jig-memory-"));
  process.env.JIG_HOME = join(project, ".jig-home");
});

const context = () => ({ cwd: project, versions: new FileVersions() });
const yes: Approve = async () => true;
const no: Approve = async () => false;
const saved = (name: string) => ({ action: "save", scope: "project", name, description: `${name} holds.`, body: "Because." });

describe("memories", () => {
  it("are saved, updated and forgotten only with approval", async () => {
    const titles: string[] = [];
    const recording: Approve = async (title, details) => (titles.push(`${title} | ${details}`), true);
    const tool = proposeMemoryTool(project, recording, () => new Date("2026-10-11T12:00:00"));
    await tool.run({ action: "save", scope: "project", name: "make-check", description: "Tests run with make check, never pytest directly", type: "feedback", body: "pytest alone skips the integration setup." }, context());
    let [memory] = loadMemories(project);
    assert.deepEqual([memory.name, memory.description, memory.type, memory.updated, memory.body], ["make-check", "Tests run with make check, never pytest directly", "feedback", "2026-10-11", "pytest alone skips the integration setup."]);
    assert.equal(memory.path, join(memoryDir("project", project), "make-check.md"));

    await tool.run({ action: "save", scope: "project", name: "make-check", description: "Tests run with make check (it sets up the database)" }, context());
    [memory] = loadMemories(project);
    assert.equal(memory.description, "Tests run with make check (it sets up the database)");
    assert.match(titles[1], /^Update \(project\): make-check \|.*replaces: Tests run with make check, never pytest directly/s);

    assert.match(await proposeMemoryTool(project, no).run(saved("other"), context()), /didn't approve|Nobody could approve/);
    assert.equal(loadMemories(project).length, 1);
    await tool.run({ action: "forget", scope: "project", name: "make-check", reason: "the Makefile is gone" }, context());
    assert.deepEqual(loadMemories(project), []);
    await assert.rejects(tool.run({ action: "forget", scope: "user", name: "make-check" }, context()), /no user memory "make-check"/);
  });

  it("are checked before anyone is asked: name, a one-line description, size, and no secrets", async () => {
    let asked = false;
    const tool = proposeMemoryTool(project, async () => ((asked = true), true));
    await assert.rejects(tool.run({ ...saved("x"), name: "Make Check" }, context()), /lowercase letters/);
    await assert.rejects(tool.run({ ...saved("x"), description: "" }, context()), /needs a description/);
    await assert.rejects(tool.run({ ...saved("x"), description: "one\ntwo" }, context()), /one line/);
    await assert.rejects(tool.run({ ...saved("x"), body: "x".repeat(3001) }, context()), /a memory is one fact/);
    await assert.rejects(tool.run({ ...saved("x"), body: "The key is sk-abcdefghijklmnopqrstuvwxyz123456" }, context()), /an API key; memories must not contain secrets/);
    assert.equal(asked, false);
  });

  it("keep user memories for every project and project memories for theirs", async () => {
    const other = await mkdtemp(join(tmpdir(), "jig-memory-other-"));
    await proposeMemoryTool(project, yes).run({ ...saved("short-answers"), scope: "user" }, context());
    await proposeMemoryTool(project, yes).run(saved("make-check"), context());
    assert.deepEqual(loadMemories(project).map((m) => `${m.scope}:${m.name}`), ["project:make-check", "user:short-answers"]);
    assert.deepEqual(loadMemories(other).map((m) => `${m.scope}:${m.name}`), ["user:short-answers"]);
  });

  it("are listed in the prompt, newest first, and read in full with the memory tool", async () => {
    const at = (date: string) => proposeMemoryTool(project, yes, () => new Date(`${date}T12:00:00`));
    await at("2026-09-01").run(saved("older"), context());
    await at("2026-10-01").run(saved("newer"), context());
    const memories = loadMemories(project);
    const prompt = memoryPrompt(memories, { proposing: false });
    assert.match(prompt, /<memories scope="project">\n- newer: newer holds\. \(2026-10-01\)\n- older: older holds\. \(2026-09-01\)\n<\/memories>/);
    assert.doesNotMatch(prompt, /propose_memory/);
    assert.match(memoryPrompt(memories, { proposing: true }), /propose a memory with propose_memory/);
    assert.equal(memoryPrompt([], { proposing: false }), "");
    assert.match(await memoryTool(memories).run({ name: "older" }, context()), /^older \(project memory, saved 2026-09-01\)\nolder holds\.\n\nBecause\.$/);
  });
});

describe("AGENTS.md proposals", () => {
  it("add a passage or replace one, shown as a diff and written only if approved", async () => {
    const shown: string[] = [];
    const tool = proposeInstructionsTool(async (title, details) => (shown.push(`${title}\n${details}`), true));
    await tool.run({ new_string: "## Tests\n\nRun them with `make check`.", reason: "the user said pytest alone skips setup" }, context());
    assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "## Tests\n\nRun them with `make check`.\n");
    assert.match(shown[0], /^Create AGENTS\.md\?\n {2}Why: the user said pytest alone skips setup\n {2}\+ ## Tests/);
    await tool.run({ old_string: "`make check`", new_string: "`make check` (never pytest directly)" }, context());
    assert.match(await readFile(join(project, "AGENTS.md"), "utf8"), /make check` \(never pytest directly\)/);
    assert.match(shown[1], /- `make check`\n {2}\+ `make check` \(never pytest directly\)/);
    await assert.rejects(tool.run({ old_string: "nowhere", new_string: "x" }, context()), /isn't in AGENTS\.md/);
    await assert.rejects(tool.run({ new_string: "token = ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, context()), /a GitHub token/);
    const before = await readFile(join(project, "AGENTS.md"), "utf8");
    await proposeInstructionsTool(no).run({ new_string: "Declined." }, context());
    assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), before);
  });

  it("edit CLAUDE.md when that is the project's instructions file", async () => {
    await writeFile(join(project, "CLAUDE.md"), "# Notes\n");
    await proposeInstructionsTool(yes).run({ new_string: "Use pnpm." }, context());
    assert.equal(await readFile(join(project, "CLAUDE.md"), "utf8"), "# Notes\n\nUse pnpm.\n");
    assert.ok(!existsSync(join(project, "AGENTS.md")));
  });
});

describe("secrets", () => {
  it("are recognized in the usual shapes, and ordinary text isn't", () => {
    assert.equal(findSecret("export DEEPSEEK_API_KEY=sk-test00000000000000000000000000"), "an API key");
    assert.equal(findSecret("AKIAIOSFODNN7EXAMPLE"), "an AWS access key");
    assert.equal(findSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), "a private key");
    assert.equal(findSecret("password: hunter22hunter"), "a password or token");
    assert.equal(findSecret("Run the tests with make check; the token budget is small."), undefined);
  });
});

describe("proposals in the agent loop", () => {
  it("run one at a time, so their questions don't overlap, and plan mode allows them", async () => {
    let open = 0;
    let overlapped = false;
    const slow: Approve = async () => {
      open++;
      overlapped ||= open > 1;
      await new Promise((done) => setTimeout(done, 20));
      open--;
      return true;
    };
    const tool = proposeMemoryTool(project, slow);
    const replies = [
      [
        { type: "tool_use", id: "a", name: "propose_memory", input: saved("first") },
        { type: "tool_use", id: "b", name: "propose_memory", input: saved("second") },
      ],
      [{ type: "text", text: "Done.", citations: null }],
    ];
    const callModel: CallModel = async () => {
      const content = replies.shift()! as Anthropic.Beta.BetaContentBlock[];
      return { message: { content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as Anthropic.Beta.BetaMessage, malformed: new Map() };
    };
    const plan = new Permissions("plan", project);
    const conversation = new Conversation(undefined, [{ role: "user", content: "remember both" }]);
    await runAgent(conversation, { callModel, tools: [tool], cwd: project, maxSteps: 5, compactAt: 0, authorize: async (t, input) => { const d = plan.decide(t, input); return d === "allow" ? null : "refused"; }, ui: { toolCall() {}, toolResult() {}, notice() {} } });
    assert.equal(overlapped, false);
    assert.deepEqual(loadMemories(project).map((m) => m.name).sort(), ["first", "second"]);
  });
});

describe("memory in the CLI", () => {
  it("shows memories to a plain task without offering to change them, and --no-memory leaves them out", async () => {
    const home = join(project, ".jig-home");
    await proposeMemoryTool(project, yes).run(saved("make-check"), context());
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "Fix the parser."], { api, cwd: project, env: { JIG_HOME: home } });
      await runJig(["--no-sandbox", "--yes", "--no-memory", "--model", "claude-haiku-4-5", "Fix the parser."], { api, cwd: project, env: { JIG_HOME: home } });
      const [withMemory, without] = api.requests as { system: { text: string }[]; tools: { name: string }[] }[];
      assert.match(systemText(withMemory), /- make-check: make-check holds\./);
      assert.ok(withMemory.tools.some((tool) => tool.name === "memory"));
      assert.ok(!withMemory.tools.some((tool) => tool.name === "propose_memory"));
      assert.doesNotMatch(systemText(without), /make-check/);
      assert.ok(!without.tools.some((tool) => tool.name === "memory"));
    } finally {
      api.close();
    }
  });

  it("reflects on the last session with jig memory reflect, and --yes keeps what it proposes", async () => {
    const home = join(project, ".jig-home");
    const api = await fakeMessagesApi((request) => {
      const last = JSON.stringify((request.messages as unknown[]).at(-1));
      if (last.includes("Look back over this conversation")) return [{ tool: "propose_memory", input: { ...saved("make-check"), description: "Tests run with make check" } }];
      return [{ text: "Done." }];
    });
    try {
      const none = await runJig(["memory", "reflect", "--no-sandbox", "--model", "claude-haiku-4-5"], { api, cwd: project, env: { JIG_HOME: home } });
      assert.notEqual(none.code, 0);
      assert.match(none.output, /no saved session in this project to reflect on/);
      await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "Run the tests."], { api, cwd: project, env: { JIG_HOME: home } });
      const reflect = await runJig(["memory", "reflect", "--no-sandbox", "--yes", "--model", "claude-haiku-4-5"], { api, cwd: project, env: { JIG_HOME: home } });
      assert.equal(reflect.code, 0, reflect.output);
      const request = api.requests.at(-2) as { tools: { name: string }[]; messages: unknown[] };
      assert.ok(request.tools.some((tool) => tool.name === "propose_memory") && request.tools.some((tool) => tool.name === "propose_instructions"));
      assert.match(JSON.stringify(request.messages[0]), /Run the tests\./, "the reflection sees the last session");
      assert.deepEqual(loadMemories(project).map((m) => m.description), ["Tests run with make check"]);
    } finally {
      api.close();
    }
  });
});
