import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../src/agent.ts";
import { Conversation } from "../src/conversation.ts";
import { type CallModel, createModel, type ModelTurn } from "../src/model.ts";
import { Permissions } from "../src/permissions.ts";
import { systemPrompt } from "../src/prompt.ts";
import { Stats } from "../src/stats.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { TOOLS, type ToolContext } from "../src/tools/index.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";
import { FileVersions } from "../src/tools/util.ts";
import { fakeMessagesApi } from "./fake-api.ts";
import { collectNotices } from "./notices.ts";

// What running jig without a person at the terminal needs: --add-dir, --stats, and not hanging on the API.

let project: string;
let outside: string;
const context = (dirs: string[] = []): ToolContext => ({ cwd: project, dirs, versions: new FileVersions() });

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "jig-headless-"));
  project = join(base, "app");
  outside = join(base, "etc");
  await mkdir(join(outside, "nginx"), { recursive: true });
  await mkdir(project);
  await writeFile(join(outside, "nginx", "nginx.conf"), "worker_processes 4;\nlisten 8080;\n");
});

describe("--add-dir", () => {
  it("lets the file tools work in the added directory, and only there", async () => {
    const conf = join(outside, "nginx", "nginx.conf");
    await assert.rejects(readTool.run({ path: conf }, context()), /outside the working directory/);
    assert.match(await readTool.run({ path: conf }, context([outside])), /listen 8080/);
    await assert.rejects(readTool.run({ path: "/etc/hosts" }, context([outside])), /only work inside it and in /);

    const ctx = context([outside]);
    await readTool.run({ path: conf }, ctx);
    await writeTool.run({ path: conf, content: "listen 9090;\n" }, ctx);
    assert.equal(await readFile(conf, "utf8"), "listen 9090;\n");
  });

  it("shows files in an added directory by their full path", async () => {
    const ctx = context([outside]);
    assert.equal(await globTool.run({ pattern: "**/*.conf", path: outside }, ctx), join(outside, "nginx", "nginx.conf"));
    assert.equal(await grepTool.run({ pattern: "listen", path: outside }, ctx), `${join(outside, "nginx", "nginx.conf")}:2: listen 8080;`);
  });

  it("counts the added directory as part of the project for permissions", () => {
    const bash = TOOLS.find((tool) => tool.definition.name === "bash")!;
    const conf = join(outside, "nginx", "nginx.conf");
    assert.equal(new Permissions("edits", project).decide(bash, { command: `cat ${conf}` }), "ask");
    assert.equal(new Permissions("edits", project, { dirs: [outside] }).decide(bash, { command: `cat ${conf}` }), "allow");
    assert.equal(new Permissions("edits", project, { dirs: [outside] }).decide(bash, { command: "cat ~/.ssh/id_rsa" }), "ask");
  });

  it("tells the model when it is on its own (a one-shot run)", () => {
    assert.match(systemPrompt(project, { oneShot: true }), /You are running one task on your own/);
    assert.doesNotMatch(systemPrompt(project), /on your own/);
  });

  it("can replace jig's own system prompt, keeping what follows it", () => {
    const prompt = systemPrompt(project, { custom: "You are a helpful assistant.\n", oneShot: true, dirs: [outside] });
    assert.match(prompt, /^You are a helpful assistant\.\n\nYou are running one task on your own/);
    assert.doesNotMatch(prompt, /coding agent|Working directory/);
  });

  it("tells the model about it", () => {
    assert.match(systemPrompt(project, { dirs: [outside] }), new RegExp(`The file tools also work in: ${outside}`));
    assert.doesNotMatch(systemPrompt(project), /also work in/);
  });
});

describe("--stats", () => {
  const turn = (content: Anthropic.Beta.BetaContentBlock[]): ModelTurn => ({
    message: {
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 },
    } as Anthropic.Beta.BetaMessage,
    malformed: new Map(),
  });

  it("keeps the counts in a file, up to date after every model call", async () => {
    const file = join(project, "stats.json");
    const stats = new Stats(file, "test-model");
    const replies = [
      turn([{ type: "tool_use", id: "t1", name: "glob", input: { pattern: "*" } } as Anthropic.Beta.BetaContentBlock]),
      turn([{ type: "text", text: "Done.", citations: null } as Anthropic.Beta.BetaContentBlock]),
    ];
    const read = async () => JSON.parse(await readFile(file, "utf8"));
    let seenAfterFirstCall: { modelCalls: number } | undefined;
    const callModel: CallModel = async () => {
      if (replies.length === 1) seenAfterFirstCall = await read();
      return replies.shift()!;
    };
    const conversation = new Conversation(undefined, [{ role: "user", content: "go" }]);
    const ui = { toolCall: (name: string) => stats.toolCall(name), toolResult() {}, notice() {} };
    const options = { callModel: stats.meter(callModel), tools: TOOLS, cwd: project, maxSteps: 5, compactAt: 0, authorize: async () => null, ui };
    stats.finish(await runAgent(conversation, options));

    assert.equal(seenAfterFirstCall?.modelCalls, 1, "written before the task ends");
    const final = await read();
    assert.deepEqual(
      { stop: final.stop, steps: final.steps, modelCalls: final.modelCalls, usage: final.usage, toolCalls: final.toolCalls },
      { stop: "end_turn", steps: 2, modelCalls: 2, usage: { input: 200, cacheWrite: 0, cacheRead: 800, output: 20 }, toolCalls: { glob: 1 } },
    );
  });
});

describe("a Messages API reply", () => {
  it("says which tools the request declared, so the loop runs only those", async () => {
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: { command: "ls" } }]);
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const tools = TOOLS.filter((tool) => ["read_file", "bash"].includes(tool.definition.name));
      const { offered } = await createModel({ model: "claude-haiku-4-5", system: "", tools, baseURL: api.url })([{ role: "user", content: "hi" }]);
      assert.deepEqual(offered, ["read_file", "bash"]);
    } finally {
      process.env = env;
      api.close();
    }
  });
});

describe("a hung API", () => {
  it("times out and retries with a notice each time, instead of waiting in silence", async () => {
    const server = createServer(() => {}); // takes the request and never answers
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const env = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { notices, stop } = collectNotices("trying again");
    try {
      const callModel = createModel({ model: "claude-haiku-4-5", system: "", tools: [], timeout: 100 });
      await assert.rejects(callModel([{ role: "user", content: "hi" }]), /timed out/i);
    } finally {
      stop();
      process.env = env;
      server.closeAllConnections();
      server.close();
    }
    assert.equal(notices.length, 2);
    assert.match(notices[0], /The API didn't answer in time; trying again \(2 tries left\)/);
  });
});

/** A server-sent event of the Messages API's stream. */
const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const message = { id: "msg", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null };
/** A streamed reply saying "Hello", in two parts, so a test can cut it off between them. */
const begin =
  event("message_start", { message: { ...message, usage: { input_tokens: 5, output_tokens: 1 } } }) +
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hel" } });
const finish =
  event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }) +
  event("content_block_stop", { index: 0 }) +
  event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
  event("message_stop", {});

describe("a reply that breaks off", () => {

  /** Calls the model against a local server whose first `drops` replies break off halfway: the connection
   * drops, or the server sends an overload error. */
  async function callWithDrops(drops: number, how: "drop" | "overload" = "drop"): Promise<{ result: Promise<ModelTurn>; notices: () => string[]; done: () => void }> {
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(begin);
      if (++requests > drops) res.end(finish);
      else if (how === "overload") res.end(event("error", { error: { type: "overloaded_error", message: "Overloaded" } }));
      else setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const env = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { notices, stop } = collectNotices("broke off");
    const result = createModel({ model: "claude-haiku-4-5", system: "", tools: [] })([{ role: "user", content: "hi" }]);
    return {
      result,
      notices: () => notices,
      done() {
        stop();
        process.env = env;
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it("asks again, with a notice, and gets the whole reply", async () => {
    const call = await callWithDrops(1);
    try {
      const turn = await call.result;
      assert.deepEqual(turn.message.content, [{ type: "text", text: "Hello" }]);
    } finally {
      call.done();
    }
    assert.match(call.notices()[0], /The reply broke off before it was finished; trying again \(2 tries left\)/);
  });

  it("asks again after an overload error in the middle of the reply", async () => {
    const call = await callWithDrops(1, "overload");
    try {
      assert.deepEqual((await call.result).message.content, [{ type: "text", text: "Hello" }]);
    } finally {
      call.done();
    }
    assert.equal(call.notices().length, 1);
  });

  it("gives up after three tries", async () => {
    const call = await callWithDrops(3);
    try {
      await assert.rejects(call.result, /terminated/);
    } finally {
      call.done();
    }
    assert.equal(call.notices().length, 2);
  });
});

describe("the task's place on the command line", () => {
  /** Runs the CLI on a task against a local fake API, which answers "Hello". Returns what the API received,
   * and the CLI's command line as `ps` showed it while the request was open. */
  async function runCli(args: string[], stdin = "", lead: string[] = []): Promise<{ code: number | null; received: string; commandLine: string }> {
    let received = "";
    let commandLine = "";
    let pid = 0;
    const server = createServer((req, res) => {
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => {
        commandLine = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(begin + finish);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const home = await mkdtemp(join(tmpdir(), "jig-home-"));
      const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ANTHROPIC_API_KEY: "test-key", JIG_HOME: home, NO_COLOR: "1" };
      const cli = join(import.meta.dirname, "..", "src", "cli.ts");
      const child = spawn(process.execPath, [cli, ...lead, "--no-sandbox", "--yes", "--model", "claude-haiku-4-5", ...args], { cwd: project, env });
      pid = child.pid!;
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end(stdin);
      const code = await new Promise<number | null>((done) => child.on("close", done));
      return { code, received, commandLine };
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }

  it("reads the task from stdin when it is -", async () => {
    const { code, received } = await runCli(["-"], "Rename server.py to app.py.\n");
    assert.equal(code, 0);
    assert.match(received, /"content":"Rename server\.py to app\.py\."/);
  });

  it("keeps jig's own skills and propose_skill out of a plain task, and gives them to jig skills new", async () => {
    const plain = JSON.parse((await runCli(["Rename server.py to app.py."])).received);
    assert.doesNotMatch(JSON.stringify(plain.system), /skill-writer/);
    assert.ok(!plain.tools.some((tool: { name: string }) => tool.name === "propose_skill"));
    const writing = await runCli(["release notes from the git log"], "", ["skills", "new"]);
    const request = JSON.parse(writing.received);
    assert.ok(request.tools.some((tool: { name: string }) => tool.name === "propose_skill"));
    assert.match(JSON.stringify(request.messages[0].content), /skill_content name=\\"skill-writer\\"[\s\S]*Write a new skill: release notes from the git log/);
  });

  it("keeps a task given as an argument out of ps, so pkill -f can't match jig", async () => {
    const { code, commandLine } = await runCli(["Rename server.py to app.py."]);
    assert.equal(code, 0);
    assert.equal(commandLine, "jig");
  });
});
