import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { messagesReply } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// eval/key_proxy.py: Terminal-Bench's containers get a token, and the proxy on the host puts the key in.

const ROOT = join(import.meta.dirname, "..");

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A provider that records what reached it, and answers with `reply` as a stream of server-sent events. */
async function fakeProvider(reply: string): Promise<{ origin: string; seen: Seen[]; close(): void }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      // In two parts, as a stream comes.
      const half = Math.floor(reply.length / 2);
      res.write(reply.slice(0, half));
      setTimeout(() => res.end(reply.slice(half)), 50);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => (server.closeAllConnections(), server.close()) };
}

const children: ChildProcess[] = [];
after(() => children.forEach((child) => child.kill()));
afterEach(removeTempDirs);

/** The Python proxy in a process of its own, forwarding to `upstream` with the key "real-key" for the token "this-run". */
async function startProxy(upstream: string): Promise<string> {
  const script = `import sys, time; sys.path.insert(0, "eval"); import key_proxy; p = key_proxy.KeyProxy(${JSON.stringify(upstream)}, "real-key", token="this-run"); print(p.port, flush=True); time.sleep(120)`;
  const child = spawn("python3", ["-c", script], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const port = await new Promise<string>((done) => child.stdout!.once("data", (data) => done(String(data).trim())));
  return `http://127.0.0.1:${port}`;
}

describe("the key proxy", () => {
  it("swaps the run's token for the key and streams the reply back", async () => {
    const provider = await fakeProvider("event: ping\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
    try {
      const proxy = await startProxy(provider.origin);
      const anthropic = await fetch(`${proxy}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": "this-run", "content-type": "application/json" }, body: '{"model":"m"}' });
      assert.equal(anthropic.status, 200);
      assert.equal(await anthropic.text(), "event: ping\ndata: {}\n\nevent: message_stop\ndata: {}\n\n");
      assert.deepEqual([provider.seen[0].path, provider.seen[0].headers["x-api-key"], provider.seen[0].body], ["/anthropic/v1/messages", "real-key", '{"model":"m"}']);
      const openai = await fetch(`${proxy}/chat/completions`, { method: "POST", headers: { authorization: "Bearer this-run" }, body: "{}" });
      assert.equal(openai.status, 200);
      assert.equal(provider.seen[1].headers.authorization, "Bearer real-key");
      assert.ok(!JSON.stringify(provider.seen).includes("this-run"), "the token stays on this side");
    } finally {
      provider.close();
    }
  });

  it("refuses any other token without calling the provider, and says so when the provider is out of reach", async () => {
    const provider = await fakeProvider("data: {}\n\n");
    try {
      const proxy = await startProxy(provider.origin);
      const wrong = await fetch(`${proxy}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": "real-key" }, body: "{}" });
      assert.equal(wrong.status, 401);
      assert.equal(provider.seen.length, 0);
    } finally {
      provider.close();
    }
    const unreachable = await startProxy("http://127.0.0.1:9"); // the discard port: nothing listens
    const response = await fetch(`${unreachable}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": "this-run" }, body: "{}" });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /could not reach 127\.0\.0\.1/);
  });

  it("carries jig's DeepSeek requests, which go to --base-url", async () => {
    const provider = await fakeProvider(messagesReply([{ text: "Done." }]));
    try {
      const proxy = await startProxy(provider.origin);
      const cwd = await tempDir("jig-proxy-");
      const env = { ...process.env, DEEPSEEK_API_KEY: "this-run", NO_COLOR: "1", JIG_HOME: await tempDir("jig-home-") };
      const child = spawn(process.execPath, [join(ROOT, "src", "cli.ts"), "--yes", "--no-sandbox", "--model", "deepseek-flash", "--base-url", `${proxy}/anthropic`, "Say done."], { cwd, env });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const code = await new Promise((done) => child.on("close", done));
      assert.equal(code, 0, output);
      assert.match(output, /Done\./);
      assert.deepEqual([provider.seen[0].path, provider.seen[0].headers["x-api-key"]], ["/anthropic/v1/messages?beta=true", "real-key"]);
    } finally {
      provider.close();
    }
  });
});
