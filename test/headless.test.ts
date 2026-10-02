import assert from "node:assert/strict";
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

describe("a hung API", () => {
  it("times out and retries with a notice each time, instead of waiting in silence", async () => {
    const server = createServer(() => {}); // takes the request and never answers
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const env = { ...process.env };
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const printed: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => printed.push(String(chunk)) > 0) as typeof process.stdout.write;
    try {
      const callModel = createModel({ model: "claude-haiku-4-5", system: "", tools: [], timeout: 100 });
      await assert.rejects(callModel([{ role: "user", content: "hi" }]), /timed out/i);
    } finally {
      process.stdout.write = write;
      process.env = env;
      server.closeAllConnections();
      server.close();
    }
    const notices = printed.join("").split("\n").filter((line) => line.includes("trying again"));
    assert.equal(notices.length, 2);
    assert.match(notices[0], /The API didn't answer in time; trying again \(2 tries left\)/);
  });
});
