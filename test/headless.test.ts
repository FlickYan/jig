import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
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
import { subagentTool } from "../src/tools/subagent.ts";
import { writeTool } from "../src/tools/write.ts";
import { FileVersions } from "../src/tools/util.ts";
import { fakeMessagesApi, messagesReply, runJig } from "./fake-api.ts";
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
    assert.deepEqual(final.events, {}, "nothing but model and tool calls happened");
  });

  it("counts the mechanisms that fired, by name, writing each count as it comes", async () => {
    const file = join(project, "stats.json");
    const stats = new Stats(file, "test-model");
    const events = async () => JSON.parse(await readFile(file, "utf8")).events;
    stats.count("retry.quiet");
    assert.deepEqual(await events(), { "retry.quiet": 1 }, "a run killed while the API is asked again still shows it");
    stats.count("retry.quiet");
    stats.count("compaction");
    assert.deepEqual(await events(), { "retry.quiet": 2, compaction: 1 });
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

  // An unescaped quote: the SDK's lenient parse cuts the command short to "echo hi > ran.txt; echo ".
  const broken = '{"command": "echo hi > ran.txt; echo "done""}';

  it("checks streamed tool input strictly, also when quiet (subagents, reviewers)", async () => {
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: broken, id: "t1" }]);
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const tools = TOOLS.filter((tool) => tool.definition.name === "bash");
      for (const quiet of [false, true]) {
        const { malformed } = await createModel({ model: "claude-haiku-4-5", system: "", tools, baseURL: api.url, quiet })([{ role: "user", content: "hi" }]);
        assert.deepEqual([...malformed], [["t1", broken]], `quiet: ${quiet}`);
      }
    } finally {
      process.env = env;
      api.close();
    }
  });

  it("keeps a subagent from running a call whose input is malformed, and tells it why", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: broken }] : [{ text: "Nothing ran." }]));
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const tools = TOOLS.filter((tool) => tool.definition.name === "bash");
      const callModel = createModel({ model: "claude-haiku-4-5", system: "", tools, baseURL: api.url, quiet: true });
      const ui = () => ({ toolCall() {}, toolResult() {}, notice() {} });
      const subagent = subagentTool({ callModel, tools, cwd: project, maxSteps: 5, compactAt: 0, authorize: async () => null, ui });
      assert.equal(await subagent.run({ description: "look", prompt: "Look around." }, context()), "Nothing ran.");
      const [, , results] = api.requests[1].messages as { content: { content: string; is_error?: boolean }[] }[];
      assert.equal(results.content[0].is_error, true);
      assert.match(results.content[0].content, /INVALID_JSON/);
      await assert.rejects(readFile(join(project, "ran.txt")), { code: "ENOENT" });
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
    const events: string[] = [];
    try {
      const callModel = createModel({ model: "claude-haiku-4-5", system: "", tools: [], timeout: 100, count: (event) => events.push(event) });
      await assert.rejects(callModel([{ role: "user", content: "hi" }]), /timed out/i);
    } finally {
      stop();
      process.env = env;
      server.closeAllConnections();
      server.close();
    }
    assert.equal(notices.length, 2);
    assert.match(notices[0], /The API didn't answer in time; trying again \(2 tries left\)/);
    assert.deepEqual(events, ["retry.api", "retry.api"], "each retry the SDK made is counted");
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

  /** Calls the model against a local server whose first `drops` replies break off: the connection drops
   * halfway, the server sends an overload error, or it goes quiet. Quiet, it sends nothing more after half
   * the reply; queued, it sends none of it, only keep-alive comments, as DeepSeek does while it holds a
   * request under load. The model gives up on either after 0.4 seconds. The notices collected are those
   * of both kinds; the events, what the model counted for --stats. */
  async function callWithDrops(drops: number, how: "drop" | "overload" | "quiet" | "queued" = "drop"): Promise<{ result: Promise<ModelTurn>; notices: () => string[]; events: string[]; done: () => void }> {
    let requests = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      const answer = ++requests > drops;
      if (answer || how !== "queued") res.write(begin);
      if (answer) res.end(finish);
      else if (how === "overload") res.end(event("error", { error: { type: "overloaded_error", message: "Overloaded" } }));
      else if (how === "queued") {
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 50);
        // Closed in the end, as DeepSeek does after 30 minutes: a call still waiting then fails, not hangs.
        const close = setTimeout(() => res.end(), 2000);
        res.on("close", () => (clearInterval(keepAlive), clearTimeout(close)));
      } else if (how === "drop") setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const env = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { notices, stop } = collectNotices("broke off", "No output");
    const events: string[] = [];
    const result = createModel({ model: "claude-haiku-4-5", system: "", tools: [], idle: 400, count: (event) => events.push(event) })([{ role: "user", content: "hi" }]);
    return {
      result,
      notices: () => notices,
      events,
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
    // and only that notice: the wait before trying again isn't a quiet reply
    assert.deepEqual(call.notices(), ["The reply broke off before it was finished; trying again (2 tries left)."]);
    assert.deepEqual(call.events, ["retry.brokeOff"]);
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
    assert.deepEqual(call.events, ["retry.brokeOff", "retry.brokeOff"], "the third failure isn't tried again, so isn't counted");
  });

  it("says so when it goes quiet partway, then asks again", async () => {
    const call = await callWithDrops(1, "quiet");
    try {
      assert.deepEqual((await call.result).message.content, [{ type: "text", text: "Hello" }]);
    } finally {
      call.done();
    }
    assert.deepEqual(call.notices(), [
      "No output from the API for 0.2 seconds; still waiting, for up to 0.4 seconds.",
      "No output from the API for 0.4 seconds; trying again (2 tries left).",
    ]);
    assert.deepEqual(call.events, ["retry.quiet"]);
  });

  it("does the same when the reply never starts, only keep-alive comments coming", async () => {
    // No event at all: the clock has to start with the response itself.
    const call = await callWithDrops(1, "queued");
    try {
      assert.deepEqual((await call.result).message.content, [{ type: "text", text: "Hello" }]);
    } finally {
      call.done();
    }
    assert.deepEqual(call.notices(), [
      "No output from the API for 0.2 seconds; still waiting, for up to 0.4 seconds.",
      "No output from the API for 0.4 seconds; trying again (2 tries left).",
    ]);
  });

  it("gives up on a reply that stays quiet after three tries, rather than waiting forever", async () => {
    const call = await callWithDrops(3, "queued");
    try {
      await assert.rejects(call.result, /no output from the API for 0\.4 seconds/);
    } finally {
      call.done();
    }
    assert.equal(call.notices().filter((notice) => notice.includes("trying again")).length, 2);
  });

  it("waits for as long as the reply keeps coming, however slowly", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      // An event every 0.25 seconds: 1.5 seconds in all, longer than the limit, but never a second without one.
      const events = messagesReply([{ text: "Hello" }]).split(/(?<=\n\n)/);
      const next = setInterval(() => {
        res.write(events.shift());
        if (events.length) return;
        clearInterval(next);
        res.end();
      }, 250);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { notices, stop } = collectNotices("No output");
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const turn = await createModel({ model: "claude-haiku-4-5", system: "", tools: [], baseURL, idle: 1000 })([{ role: "user", content: "hi" }]);
      assert.deepEqual(turn.message.content, [{ type: "text", text: "Hello" }]);
    } finally {
      stop();
      process.env = env;
      server.closeAllConnections();
      server.close();
    }
    assert.deepEqual(notices, []);
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

describe("a one-shot run that continues the last session", () => {
  it("goes on from the session's messages, the new task on stdin, as Terminal-Bench's adapter sends a review's problems", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const cwd = await mkdtemp(join(tmpdir(), "jig-continue-"));
      const env = { JIG_HOME: await mkdtemp(join(tmpdir(), "jig-home-")) };
      const first = await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--", "-"], { api, cwd, env, stdin: "Write out.txt." });
      const second = await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--continue", "--", "-"], { api, cwd, env, stdin: "A reviewer found problems: out.txt is empty." });
      assert.deepEqual([first.code, second.code], [0, 0], second.output);
      const messages = api.requests[1].messages as { role: string; content: unknown }[];
      assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
      assert.match(JSON.stringify(messages[0].content), /Write out\.txt\./);
      assert.match(JSON.stringify(messages[2].content), /A reviewer found problems: out\.txt is empty\./);
    } finally {
      api.close();
    }
  });
});

describe("a run that reaches --max-steps", () => {
  it("asks the model, without tools, what it did and what is left, prints that, and counts the call; --no-wrap-up doesn't", async () => {
    const api = await fakeMessagesApi((request) => (request.tool_choice ? [{ text: "Listed the files; nothing verified; the fix is left." }] : [{ tool: "glob", input: { pattern: "*" } }]));
    try {
      const file = join(project, "stats.json");
      const args = ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--max-steps", "2", "--stats", file];
      const { code, output } = await runJig([...args, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 2, output);
      assert.equal(api.requests.length, 3);
      const last = api.requests[2];
      assert.deepEqual(last.tool_choice, { type: "none" });
      assert.ok((last.tools as unknown[]).length > 0, "the tools stay declared, so the cached prefix stays the same");
      assert.match(output, /Out of steps: asking the model where the work stands\.\nListed the files; nothing verified; the fix is left\.\nStopped after 2 steps \(raise the limit with --max-steps\)\.\n2 steps · /);
      const stats = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual([stats.stop, stats.steps, stats.modelCalls, stats.usage.input], ["max_steps", 2, 3, 30]);
      assert.deepEqual(stats.events, { wrapUp: 1 });

      const off = await runJig([...args, "--no-wrap-up", "Fix the parser."], { api, cwd: project });
      assert.equal(api.requests.length, 5);
      assert.doesNotMatch(off.output, /Out of steps|Listed the files/);
      assert.match(off.output, /Stopped after 2 steps/);
    } finally {
      api.close();
    }
  });
});

describe("a one-shot run's exit code", () => {
  const args = ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--no-wrap-up"];
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");

  it("says whether the task finished, and if not, why it stopped", async () => {
    // The task says how the model behaves: answers, calls tools until the steps run out, is cut off, declines.
    const api = await fakeMessagesApi((request) => {
      const task = JSON.stringify((request.messages as { content: unknown }[])[0].content);
      if (task.includes("Search")) return [{ tool: "glob", input: { pattern: "*" } }];
      if (task.includes("Ramble")) return { blocks: [{ text: "and so on, and" }], stop: "max_tokens" };
      if (task.includes("Decline")) return { blocks: [], stop: "refusal" };
      return [{ text: "Done." }];
    });
    try {
      const codes: Record<string, number | null> = {};
      for (const task of ["Finish.", "Search.", "Ramble.", "Decline."]) codes[task] = (await runJig([...args, "--max-steps", "3", task], { api, cwd: project })).code;
      assert.deepEqual(codes, { "Finish.": 0, "Search.": 2, "Ramble.": 3, "Decline.": 4 });
    } finally {
      api.close();
    }
  });

  it("is 6 when the model makes the same calls, with the same results, 5 steps in a row", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Let me list them again." }, { tool: "glob", input: { pattern: "*" } }]);
    try {
      const file = join(outside, "stats.json");
      const { code, output } = await runJig([...args, "--stats", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 6, output);
      assert.equal(api.requests.length, 5);
      assert.match(output, /Stopped: the model made the same tool calls, and got the same results, 5 steps in a row\.\n5 steps · /);
      assert.equal(JSON.parse(await readFile(file, "utf8")).stop, "loop");
    } finally {
      api.close();
    }
  });

  it("is 130 after Ctrl+C", async () => {
    let pid = 0;
    const server = createServer((req) => {
      req.resume();
      process.kill(pid, "SIGINT"); // and never answers
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, ANTHROPIC_API_KEY: "test-key", JIG_HOME: await mkdtemp(join(tmpdir(), "jig-home-")), NO_COLOR: "1" };
      const child = spawn(process.execPath, [cli, ...args, "Fix the parser."], { cwd: project, env });
      pid = child.pid!;
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.stdin.end();
      const code = await new Promise<number | null>((done) => child.on("close", done));
      assert.equal(code, 130, output);
      assert.match(output, /Interrupted\./);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("is listed in --help", () => {
    const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).replace(/\s+/g, " ");
    assert.match(help, /exits with 0 when the model finished, 1 on an error, 2 when it ran out of steps \(--max-steps\), 3 when a reply hit the output limit or the context window, 4 when the model declined, 5 when tool calls needed approval and there was no terminal to ask \(see --yes\), 6 when the model made the same tool calls, with the same results, 5 steps in a row, 7 when it reached --time-limit, and 130 when interrupted\./);
  });
});

describe("a one-shot run with --time-limit", () => {
  const args = ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5"];

  it("stops at the limit, a command still running included, starts no model call after it, and exits with 7", async () => {
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: { command: "sleep 30" } }]);
    try {
      const file = join(outside, "stats.json");
      const started = Date.now();
      const { code, output } = await runJig([...args, "--time-limit", "1", "--stats", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 7, output);
      assert.ok(Date.now() - started < 10_000, "the command was stopped, not waited for");
      assert.equal(api.requests.length, 1);
      assert.match(output, /Killed: the time limit \(--time-limit\) was reached\.\nStopped at the time limit \(--time-limit\)\.\n1 step · /);
      assert.equal(JSON.parse(await readFile(file, "utf8")).stop, "time_limit");
    } finally {
      api.close();
    }
  });

  it("stops a model call still waiting at the limit", async () => {
    const server = createServer((req) => req.resume()); // takes the request and never answers
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    try {
      const started = Date.now();
      const { code, output } = await runJig([...args, "--time-limit", "1", "Fix the parser."], { api, cwd: project });
      assert.equal(code, 7, output);
      assert.ok(Date.now() - started < 10_000, "the API's own timeout is 2 minutes");
      assert.match(output, /Stopped at the time limit \(--time-limit\)\.\n0 steps · /);
    } finally {
      api.close();
    }
  });

  it("still checks the work with --check while most of the time is left", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const { code, output } = await runJig([...args, "--check", "--time-limit", "600", "Fix the parser."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.equal(api.requests.length, 2);
      assert.doesNotMatch(output, /Too little time/);
    } finally {
      api.close();
    }
  });

  /** With --check and 4 seconds, the model runs `sleep <seconds>`, then says it is done, and is asked to check. */
  async function checkAfter(seconds: number): Promise<{ code: number | null; output: string; requests: number; events: Record<string, number> }> {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: `sleep ${seconds}` } }] : [{ text: "Done." }]));
    try {
      const file = join(outside, "stats.json");
      const { code, output } = await runJig([...args, "--check", "--time-limit", "4", "--stats", file, "Fix the parser."], { api, cwd: project });
      return { code, output, requests: api.requests.length, events: JSON.parse(await readFile(file, "utf8")).events };
    } finally {
      api.close();
    }
  }

  it("checks it past the first quarter of the time too", async () => {
    const { code, output, requests, events } = await checkAfter(1.2);
    assert.equal(code, 0, output);
    assert.equal(requests, 3, "the command, the answer, and the answer after the check");
    assert.doesNotMatch(output, /Too little time/);
    assert.deepEqual(events, { check: 1 });
  });

  it("doesn't check it in the last quarter, says so, and counts that", async () => {
    // Past 3 of the 4 seconds, with the rest left to answer in.
    const { code, output, requests, events } = await checkAfter(3.1);
    assert.equal(code, 0, output);
    assert.equal(requests, 2);
    assert.match(output, /Too little time is left to check the work \(--time-limit\), so it stands as it is\./);
    assert.deepEqual(events, { "check.skipped": 1 });
  });

  it("is still a Ctrl+C when the deadline passes while the task stops", async () => {
    // The command starts a job that leaves its process group, so jig's kill misses it and its output stays open,
    // then presses Ctrl+C itself, inside the 1 second: jig waits a second for the job's last output, and the
    // deadline passes meanwhile.
    const job = `python3 -c 'import os, time; os.setsid(); open("ready", "w").close(); time.sleep(3)' & until [ -e ready ]; do sleep 0.05; done; kill -INT $PPID; sleep 30`;
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: { command: job } }]);
    try {
      const file = join(outside, "stats.json");
      const { code, output } = await runJig([...args, "--time-limit", "1", "--stats", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 130, output);
      assert.match(output, /Killed: the user interrupted it\./);
      assert.match(output, /\nInterrupted\.\n1 step · /);
      assert.doesNotMatch(output, /time limit/);
      assert.equal(JSON.parse(await readFile(file, "utf8")).stop, "interrupted");
    } finally {
      api.close();
    }
  });

  it("refuses a limit that isn't a positive number of seconds, or is too long for a timer", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      for (const limit of ["0", "soon", "1e9"]) {
        const { code, output } = await runJig([...args, "--time-limit", limit, "Fix the parser."], { api, cwd: project });
        assert.equal(code, 1, output);
        assert.match(output, /--time-limit must be a positive number of seconds/);
      }
      assert.equal(api.requests.length, 0);
    } finally {
      api.close();
    }
  });
});

describe("a one-shot run with no terminal", () => {
  const args = ["--no-sandbox", "--model", "claude-haiku-4-5"];

  it("stops at the third tool call that needed approval, rather than spending its steps on calls that can't run", async () => {
    const api = await fakeMessagesApi((request) => [{ tool: "bash", input: { command: `touch made-${(request.messages as unknown[]).length}` } }]);
    try {
      const file = join(project, "stats.json");
      const { code, output } = await runJig([...args, "--stats", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 5, output);
      assert.equal(api.requests.length, 3);
      assert.match(output, /Stopped: 3 tool calls needed approval, and with no terminal there is no one to give it\. Run jig with --yes/);
      const stats = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual([stats.stop, stats.events], ["unapproved", { "call.unapproved": 3, "call.refused": 3 }]);
    } finally {
      api.close();
    }
  });

  it("goes on after one, which the model may manage without", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "touch made" } }] : [{ text: "Done without it." }]));
    try {
      const { code, output } = await runJig([...args, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.match(output, /Not run: there is no one to approve it \(no terminal\)/);
      assert.equal(api.requests.length, 2);
    } finally {
      api.close();
    }
  });
});

describe("a hook configured as for Claude Code", () => {
  it('runs around every call with the matcher "*", without jig\'s API key', async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "echo listed" } }] : [{ text: "Done." }]));
    try {
      const home = await mkdtemp(join(tmpdir(), "jig-home-"));
      const hook = { matcher: "*", command: 'echo "$JIG_TOOL ${ANTHROPIC_API_KEY:-without a key}" >> "$JIG_PROJECT_DIR/hooked.txt"' };
      await writeFile(join(home, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [hook] } }));
      const { code, output } = await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "list the files"], { api, cwd: project, env: { JIG_HOME: home } });
      assert.equal(code, 0, output);
      assert.equal(await readFile(join(project, "hooked.txt"), "utf8"), "bash without a key\n");
      const [, , results] = api.requests[1].messages as { content: { type: string; content: string }[] }[];
      assert.match(results.content[0].content, /^listed\n\nExit code: 0$/);
    } finally {
      api.close();
    }
  });

  it("sends the model back from a Stop until the project's check passes, and skips events jig doesn't have", async () => {
    // The model says it is done at once; sent back, it writes the file the check wants, and is done again.
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 3 ? [{ tool: "write_file", input: { path: "done.txt", content: "done\n" } }] : [{ text: "Done." }],
    );
    try {
      const home = await mkdtemp(join(tmpdir(), "jig-home-"));
      const log = join(outside, "stops.jsonl");
      const check = { command: `{ cat; echo; } >> ${JSON.stringify(log)}; test -f done.txt || { echo "done.txt is missing" >&2; exit 2; }` };
      await writeFile(join(home, "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "echo hi" }], Stop: [check] } }));
      const file = join(outside, "stats.json");
      const args = ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--stats", file, "Write done.txt."];
      const { code, output } = await runJig(args, { api, cwd: project, env: { JIG_HOME: home } });
      assert.equal(code, 0, output);
      assert.match(output, /settings\.json: jig has no hook event "SessionStart", so those hooks don't run/);
      assert.match(output, /A Stop hook says the task isn't done \("done\.txt is missing"\); the model goes on \(1 of 3\)\./);
      assert.equal(api.requests.length, 3);
      const sentBack = (api.requests[1].messages as { content: unknown }[])[2];
      assert.match(JSON.stringify(sentBack.content), /says the task isn't done:\\n\\ndone\.txt is missing\\n/);
      const stops = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(
        stops.map((stop) => [stop.event, stop.task, stop.last_message, stop.stop_hook_active, stop.changed_files]),
        [
          ["Stop", "Write done.txt.", "Done.", false, []],
          ["Stop", "Write done.txt.", "Done.", true, ["done.txt"]],
        ],
      );
      assert.deepEqual([stops[0].cwd, stops[0].session_path.endsWith(".jsonl")], [await realpath(project), true]);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).events, { "hook.stopBlocked": 1 });
    } finally {
      api.close();
    }
  });
});
