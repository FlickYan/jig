import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { costOf } from "../src/prices.ts";
import { type Gateway, type GatewayConfig, startGateway } from "../server/gateway.ts";
import { Redis } from "../server/redis.ts";
import { MemoryState, RedisState, utcDay } from "../server/state.ts";
import { mintToken, type TokenPayload, verifyToken } from "../server/token.ts";
import { fakeMessagesApi, messagesReply, runJig } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// server/gateway.ts: tasks call the Messages API with a token, and the gateway calls the provider with a
// key from its pool, within each tenant's limits, counting what each task spends.

const ROOT = join(import.meta.dirname, "..");
const SECRET = "test-secret";
const KEYS = { POOL_KEY_1: "pool-key-1", POOL_KEY_2: "pool-key-2" };
const MODEL = "claude-sonnet-5-5"; // one with a price

function token(fields: Partial<TokenPayload> = {}, secret = SECRET): string {
  return mintToken(secret, { tenant: "acme", task: "t1", exp: Math.floor(Date.now() / 1000) + 3600, budgetUsd: null, ...fields });
}

/** A request body as jig sends one; `content` tells requests apart at the provider. */
function body(content = "hi", model = MODEL): string {
  return `{"model":"${model}",  "max_tokens":64000,"stream":true,"messages":[{"role":"user","content":"${content} é \\u00e9"}]}`;
}

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const closing: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  await removeTempDirs();
});

/** A provider that records what reached it and answers with `answer`, which ends the reply itself. */
async function fakeProvider(answer: (seen: Seen, res: ServerResponse) => void = (_, res) => streamed(res)): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const request = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      answer(request, res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closing.push(() => (server.closeAllConnections(), server.close()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** A streamed reply of "Done.": 10 tokens in, 5 out. */
function streamed(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(messagesReply([{ text: "Done." }]));
}

async function gateway(upstream: string, config: Partial<GatewayConfig> = {}, env: NodeJS.ProcessEnv = {}): Promise<Gateway> {
  const gw = await startGateway(
    { listen: { port: 0 }, upstream: { baseUrl: upstream, keyEnv: ["POOL_KEY_1"] }, ...config },
    { JIG_GATEWAY_SECRET: SECRET, ...KEYS, ...env },
  );
  closing.push(() => gw.close());
  return gw;
}

function ask(gw: Gateway, credential: string, content?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${gw.url}/anthropic/v1/messages?beta=true`, {
    method: "POST",
    headers: { "x-api-key": credential, "content-type": "application/json", ...headers },
    body: body(content),
  });
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (const start = Date.now(); !(await condition()); await new Promise((done) => setTimeout(done, 10))) {
    if (Date.now() - start > 5000) throw new Error(`timed out waiting for ${what}`);
  }
}

async function metric(gw: Gateway, series: string): Promise<number | undefined> {
  const text = await (await fetch(`${gw.url}/metrics`)).text();
  const line = text.split("\n").find((line) => line.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe("the gateway's tokens", () => {
  it("verifies its own tokens and says what is wrong with any other", () => {
    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(verifyToken(SECRET, token({ exp: now + 60, budgetUsd: 2 })), { tenant: "acme", task: "t1", exp: now + 60, budgetUsd: 2 });
    const [prefix, payload, signature] = token().split(".");
    const forged = Buffer.from(JSON.stringify({ tenant: "other", task: "t1", exp: now + 60, budgetUsd: null })).toString("base64url");
    const refused = [
      ["not a gateway token", "sk-ant-real-key"],
      ["signature does not match", token({}, "another-secret")],
      ["signature does not match", `${prefix}.${forged}.${signature}`],
      ["expired", token({ exp: now - 1 })],
    ];
    for (const [why, given] of refused) {
      const result = verifyToken(SECRET, given);
      assert.ok(result instanceof Error && result.message.includes(why), `${why}: ${result}`);
    }
    assert.match(String(verifyToken("", payload)), /no secret/);
  });
});

describe("the gateway", () => {
  it("streams the reply as it comes, the body unchanged and a pool key in place of the token", async () => {
    let release!: () => void;
    const released = new Promise<void>((done) => (release = done));
    let finished = false;
    const reply = messagesReply([{ text: "Done." }]);
    const firstEvent = reply.indexOf("\n\n") + 2;
    const provider = await fakeProvider(async (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(reply.slice(0, firstEvent));
      await released; // the rest only once jig has had the first event
      res.end(reply.slice(firstEvent));
      finished = true;
    });
    // DeepSeek's Anthropic-compatible API is at a path: the request goes under it.
    const gw = await gateway(`${provider.url}/anthropic`);
    const credential = token();
    const first = (async () => {
      const response = await ask(gw, credential);
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      return { reader, chunk: await reader.read() };
    })();
    first.catch(() => {}); // when it is held back, the race below says so
    let timer: NodeJS.Timeout | undefined;
    const heldBack = new Promise<never>((_, failed) => (timer = setTimeout(() => failed(new Error("the first event was held back")), 5000)));
    let reader: ReadableStreamDefaultReader<Uint8Array>, chunk: ReadableStreamReadResult<Uint8Array>, early: boolean;
    try {
      ({ reader, chunk } = await Promise.race([first, heldBack]));
      early = !finished;
    } finally {
      clearTimeout(timer);
      release();
    }
    assert.match(new TextDecoder().decode(chunk.value), /^event: message_start/);
    assert.ok(early, "the first event arrived before the provider finished");
    let rest = new TextDecoder().decode(chunk.value);
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    assert.equal(rest, reply);

    const [seen] = provider.seen;
    assert.equal(seen.path, "/anthropic/v1/messages?beta=true");
    assert.ok(seen.body.equals(Buffer.from(body())), "the body reached the provider byte for byte");
    assert.equal(seen.headers["x-api-key"], "pool-key-1");
    // A bearer token, as the OpenAI SDK sends a key, works too, and the provider never sees it.
    assert.equal((await ask(gw, "", "bearer", { authorization: `Bearer ${credential}` })).status, 200);
    assert.equal(provider.seen[1].headers["x-api-key"], "pool-key-1");
    assert.equal(provider.seen[1].headers.authorization, undefined);
    assert.ok(!JSON.stringify(provider.seen.map((s) => s.headers)).includes(credential), "the token stays on this side");
  });

  it("refuses a missing, foreign, forged or expired token without calling the provider", async () => {
    const provider = await fakeProvider();
    const gw = await gateway(provider.url);
    const [prefix, , signature] = token().split(".");
    const forged = Buffer.from(JSON.stringify({ tenant: "acme", task: "t1", exp: 9e9, budgetUsd: null })).toString("base64url");
    for (const credential of ["", "sk-ant-real-key", token({}, "another-secret"), `${prefix}.${forged}.${signature}`, token({ exp: 1 })]) {
      const response = await ask(gw, credential);
      assert.equal(response.status, 401, credential);
      assert.equal((await response.json()).error.type, "authentication_error");
    }
    assert.equal(provider.seen.length, 0);
  });

  it("queues a request over its tenant's rate, then turns one away with retry-after", async () => {
    const provider = await fakeProvider();
    // One request every half second, none saved up; a request waits 0.7 seconds at most.
    const gw = await gateway(provider.url, { limits: { maxWaitMs: 700, tenantDefaults: { requestsPerMinute: 120, burst: 1 } } });
    const start = Date.now();
    const timed = async () => {
      const response = await ask(gw, token());
      await response.arrayBuffer();
      return { status: response.status, ms: Date.now() - start, retryAfter: response.headers.get("retry-after") };
    };
    const results = (await Promise.all([timed(), timed(), timed()])).sort((a, b) => a.ms - b.ms);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 429]);
    const served = results.filter((r) => r.status === 200);
    assert.ok(served[1].ms >= 400, `the second waited for the bucket (${served[1].ms} ms)`);
    const refused = results.find((r) => r.status === 429)!;
    assert.ok(refused.ms >= 650, `the third waited before it was turned away (${refused.ms} ms)`);
    assert.ok(Number(refused.retryAfter) >= 1, `retry-after: ${refused.retryAfter}`);
    assert.equal(provider.seen.length, 2);
    // Another tenant has a bucket of its own.
    assert.equal((await ask(gw, token({ tenant: "other" }))).status, 200);
  });

  it("serves the tenants in turn: one flooding it delays another's request by one slot at most", async () => {
    const held: ServerResponse[] = [];
    let hold = true;
    const provider = await fakeProvider((_, res) => (hold ? held.push(res) : streamed(res)));
    const gw = await gateway(provider.url, { limits: { concurrent: 1 } });
    const flood = Array.from({ length: 6 }, (_, i) => ask(gw, token({ tenant: "flood", task: "f" }), `flood-${i}`));
    await until(async () => provider.seen.length === 1 && (await metric(gw, "jig_gateway_queued")) === 5, "the flood to queue up");
    const other = ask(gw, token({ tenant: "other", task: "o" }), "other");
    await until(async () => (await metric(gw, "jig_gateway_queued")) === 6, "the other tenant's request to queue");
    hold = false;
    held.forEach((res) => streamed(res));
    const responses = await Promise.all([...flood, other]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200, 200, 200]);
    const order = provider.seen.map((seen) => /"content":"([a-z0-9-]+)/.exec(seen.body.toString())![1]);
    assert.equal(order[1], "other", `the order the provider saw: ${order.join(", ")}`);
    assert.equal(order.length, 7);
  });

  it("rests a key the provider rate-limits or refuses, and sends the request with another", async () => {
    const provider = await fakeProvider((seen, res) => {
      if (seen.headers["x-api-key"] === "pool-key-1") return void res.writeHead(429, { "retry-after": "60", "content-type": "application/json" }).end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
      if (seen.headers["x-api-key"] === "revoked") return void res.writeHead(401).end();
      streamed(res);
    });
    const gw = await gateway(provider.url, { upstream: { baseUrl: provider.url, keyEnv: ["POOL_KEY_1", "POOL_KEY_2"] } });
    for (let i = 0; i < 3; i++) assert.equal((await ask(gw, token())).status, 200);
    // The first request met the rate limit and went again with the other key; the rest went to that one.
    assert.deepEqual(provider.seen.map((s) => s.headers["x-api-key"]), ["pool-key-1", "pool-key-2", "pool-key-2", "pool-key-2"]);

    // With no other key, the provider's 429 goes back to jig, whose SDK waits as it says: no retries from here.
    const alone = await fakeProvider((_, res) => void res.writeHead(429, { "retry-after": "60" }).end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'));
    const one = await gateway(alone.url);
    const limited = await ask(one, token());
    assert.deepEqual([limited.status, limited.headers.get("retry-after"), alone.seen.length], [429, "60", 1]);
    // While the key rests, the gateway says so itself.
    const resting = await ask(one, token());
    assert.equal(resting.status, 429);
    assert.ok(Number(resting.headers.get("retry-after")) >= 59);
    assert.equal(alone.seen.length, 1);

    // A key the provider refuses is never used again.
    const revoked = await gateway(provider.url, { upstream: { baseUrl: provider.url, keyEnv: ["REVOKED", "POOL_KEY_2"] } }, { REVOKED: "revoked" });
    provider.seen.length = 0;
    for (let i = 0; i < 3; i++) assert.equal((await ask(revoked, token())).status, 200);
    assert.deepEqual(provider.seen.map((s) => s.headers["x-api-key"]), ["revoked", "pool-key-2", "pool-key-2", "pool-key-2"]);
    assert.equal(await metric(revoked, 'jig_gateway_upstream_errors_total{status="401"}'), 1);
  });

  it("counts the usage of streamed and whole replies, by task and tenant", async () => {
    const whole = { id: "m", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Done." }], usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 20 } };
    const provider = await fakeProvider((seen, res) => {
      if (seen.body.includes("whole")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(whole));
      streamed(res);
    });
    const gw = await gateway(provider.url, { adminTokenEnv: "ADMIN_TOKEN" }, { ADMIN_TOKEN: "admin-secret" });
    const credential = token({ task: "t1" });
    assert.equal(await (await ask(gw, credential, "streamed")).text(), messagesReply([{ text: "Done." }]));
    assert.deepEqual(await (await ask(gw, credential, "whole")).json(), whole);
    const usage = { input: 110, cacheRead: 1000, cacheWrite: 50, output: 25 };
    const costUsd = costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })! + costOf(MODEL, { input: 100, cacheRead: 1000, cacheWrite: 50, output: 20 })!;
    const expected = { task: "t1", tenant: "acme", requests: 2, usage, costUsd, unpriced: 0, budgetUsd: null };
    const read = (task: string, credential: string) => fetch(`${gw.url}/usage/${task}`, { headers: { authorization: `Bearer ${credential}` } });
    assert.deepEqual(await (await read("t1", credential)).json(), expected);
    assert.deepEqual(await (await read("t1?tenant=acme", "admin-secret")).json(), expected);
    // Task ids are unique only within a tenant, so the admin names the tenant too.
    assert.equal((await read("t1", "admin-secret")).status, 400);
    assert.equal((await read("t1", token({ task: "t2" }))).status, 403);
    assert.equal((await read("t1", "wrong")).status, 401);
    assert.equal((await read("t9?tenant=acme", "admin-secret")).status, 404);
    assert.equal((await (await read("t2", token({ task: "t2" }))).json()).requests, 0);
    // Another tenant's task t1 is another task: its token reads its own, nothing yet, and never acme's.
    assert.deepEqual(await (await read("t1", token({ tenant: "rival" }))).json(), { ...expected, tenant: "rival", requests: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0 });
    assert.equal((await read("t1?tenant=acme", token({ tenant: "rival" }))).status, 403);
    assert.equal((await read("%E0", credential)).status, 400);
    assert.equal(await metric(gw, 'jig_gateway_tokens_total{tenant="acme",kind="output"}'), 25);
    assert.equal(await metric(gw, 'jig_gateway_requests_total{tenant="acme"}'), 2);
    assert.equal(await metric(gw, "jig_gateway_in_flight"), 0);
  });

  it("breaks off its reply when the provider's does, counting what came before", async () => {
    // The provider sends its first event, 10 tokens in, then drops the connection.
    const reply = messagesReply([{ text: "Done." }]);
    const provider = await fakeProvider((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(reply.slice(0, reply.indexOf("\n\n") + 2), () => setTimeout(() => res.socket?.destroy(), 50));
    });
    const gw = await gateway(provider.url);
    const response = await ask(gw, token({ task: "dropped" }));
    assert.equal(response.status, 200);
    // jig sees the break and can ask again, rather than waiting on a stream that never ends.
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<string>((done) => (timer = setTimeout(() => done("hung"), 3000)));
    const outcome = await Promise.race([response.text().then(() => "ended", () => "broke off"), hung]).finally(() => clearTimeout(timer));
    assert.equal(outcome, "broke off");
    await until(async () => (await metric(gw, "jig_gateway_in_flight")) === 0, "the request to give back its slot");
    const spent = await (await fetch(`${gw.url}/usage/dropped`, { headers: { "x-api-key": token({ task: "dropped" }) } })).json();
    assert.deepEqual([spent.requests, spent.usage.input, spent.usage.output], [1, 10, 1]);
  });

  it("answers 402 once a task has spent its budget", async () => {
    const provider = await fakeProvider();
    const gw = await gateway(provider.url);
    // Each reply costs $0.00007 at claude-sonnet-5-5's price, so after two the task has spent its $0.0001.
    const credential = token({ task: "capped", budgetUsd: 0.0001 });
    assert.deepEqual([(await ask(gw, credential)).status, (await ask(gw, credential)).status], [200, 200]);
    const over = await ask(gw, credential);
    assert.equal(over.status, 402);
    assert.equal((await over.json()).error.type, "billing_error");
    assert.equal(provider.seen.length, 2);
    // Another task of the tenant has its own budget, and so has another tenant's task of the same id.
    assert.equal((await ask(gw, token({ task: "fresh", budgetUsd: 0.0001 }))).status, 200);
    assert.equal((await ask(gw, token({ tenant: "rival", task: "capped", budgetUsd: 0.0001 }))).status, 200);
    // A budget of nothing allows nothing, the first request included.
    const none = await ask(gw, token({ task: "nothing", budgetUsd: 0 }));
    assert.equal(none.status, 402);
    assert.equal(provider.seen.length, 4);
    // A budget needs a price to count against.
    const unpriced = await fetch(`${gw.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token({ task: "haiku", budgetUsd: 1 }) }, body: body("hi", "claude-haiku-4-5") });
    assert.equal(unpriced.status, 400);
    assert.equal(provider.seen.length, 4);
  });

  it("carries a task of jig's own, its token as the API key", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "write_file", input: { path: "done.txt", content: "done\n" } }] : [{ text: "Done." }]));
    closing.push(() => api.close());
    const gw = await gateway(api.url);
    const credential = token({ task: "jig-run" });
    const cwd = await tempDir("jig-gateway-");
    const args = ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--base-url", `${gw.url}/anthropic`, "Write done.txt."];
    const { code, output } = await runJig(args, { api, cwd, env: { ANTHROPIC_API_KEY: credential } });
    assert.equal(code, 0, output);
    assert.match(output, /Done\./);
    const spent = await (await fetch(`${gw.url}/usage/jig-run`, { headers: { "x-api-key": credential } })).json();
    assert.deepEqual([spent.requests, spent.usage.input, spent.usage.output, spent.unpriced], [2, 20, 10, 2]);
    assert.equal(api.requests.length, 2);
  });

  it("starts from a config file, and says what is missing from one", async () => {
    const dir = await tempDir("jig-gateway-");
    const config = join(dir, "gateway.json");
    await writeFile(config, JSON.stringify({ listen: { port: 0 }, upstream: { baseUrl: "http://127.0.0.1:9", keyEnv: ["POOL_KEY_1"] } }));
    const run = (env: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, [join(ROOT, "server", "gateway.ts"), "--config", config], { env: { PATH: process.env.PATH, ...env } });
      closing.push(() => child.kill());
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      return { child, output: () => output, exited: new Promise<number | null>((done) => child.on("exit", done)) };
    };
    const missing = run({ JIG_GATEWAY_SECRET: SECRET });
    assert.equal(await missing.exited, 1);
    assert.match(missing.output(), /No key in POOL_KEY_1/);
    const started = run({ JIG_GATEWAY_SECRET: SECRET, ...KEYS });
    await until(() => /listening on http/.test(started.output()), "the gateway to start");
    const url = /listening on (\S+)/.exec(started.output())![1];
    assert.equal(await (await fetch(`${url}/healthz`)).text(), "ok\n");
    started.child.kill("SIGTERM");
    assert.equal(await started.exited, 0);
  });
});

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

describe("the gateway's state in memory", () => {
  it("forgets a task a day past its token, and a tenant's bucket once it is full again", async () => {
    const state = new MemoryState();
    closing.push(() => state.close());
    const now = Date.now();
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
    await state.spend({ tenant: "acme", task: "old", exp: Math.floor(now / 1000) - 2 * 86_400, budgetUsd: null }, usage, 0.01);
    await state.spend({ tenant: "acme", task: "live", exp: Math.floor(now / 1000) + 60, budgetUsd: null }, usage, 0.01);
    assert.equal(await state.admit("acme", "r1", { tenant: { requestsPerMinute: 60, concurrent: 1 }, global: {} }), 0);
    assert.equal(await state.admit("acme", "r2", { tenant: { requestsPerMinute: 60, concurrent: 1 }, global: {} }), Infinity);
    await state.release("acme");
    state.prune(now + 60_000);
    assert.equal(await state.spent("acme", "old"), undefined);
    assert.equal((await state.spent("acme", "live"))?.requests, 1);
    // The day's total stays for billing; the bucket, full again a minute later, and the slot given back, go.
    assert.equal((await state.spentOn("acme", utcDay(now)))?.requests, 2);
    assert.equal(state.size, 2);
  });
});

describe("the gateway without its Redis", () => {
  it("answers 503 when it is to refuse ('closed', the default), and goes on alone when 'open'", async () => {
    const provider = await fakeProvider();
    const redis = `redis://127.0.0.1:${await deadPort()}/1`;
    const closed = await gateway(provider.url, { state: { redis } });
    const refused = await ask(closed, token());
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "1");
    assert.match((await refused.json()).error.message, /shared state can't be reached/);
    assert.ok((await metric(closed, "jig_gateway_state_errors_total"))! >= 1);
    assert.equal(provider.seen.length, 0);
    // Open, it holds the tenant to its limits with its own counts, and still counts what the task spends.
    const open = await gateway(provider.url, { state: { redis, onStateError: "open" }, limits: { maxWaitMs: 300, tenantDefaults: { requestsPerMinute: 1 } } });
    assert.deepEqual([(await ask(open, token({ budgetUsd: 1 }))).status, (await ask(open, token())).status], [200, 429]);
    assert.equal((await (await fetch(`${open.url}/usage/t1`, { headers: { "x-api-key": token() } })).json()).requests, 1);
    assert.equal(provider.seen.length, 1);
  });

  it("says what is wrong with its state's config before it starts", async () => {
    await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "http://cache:6379" } }), /state.redis must be a Redis URL/);
    await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "redis://cache", onStateError: "maybe" as "open" } }), /onStateError/);
  });
});

// These need a Redis to share: JIG_TEST_REDIS_URL, say redis://127.0.0.1:6379/1. Each test keeps its keys
// under a prefix of its own and deletes them after.
const REDIS = process.env.JIG_TEST_REDIS_URL;

describe("gateways sharing a Redis", { skip: !REDIS && "set JIG_TEST_REDIS_URL to a Redis these tests may write to" }, () => {
  const prefix = () => {
    const prefix = `jig:test:${randomUUID()}:`;
    closing.push(async () => {
      const redis = new Redis(REDIS!);
      const keys = (await redis.command(["KEYS", `${prefix}*`])) as string[];
      if (keys.length) await redis.command(["DEL", ...keys]);
      redis.close();
    });
    return prefix;
  };

  /** A provider that answers after `ms`, counting the requests it holds at once. */
  async function slowProvider(ms: number): Promise<{ url: string; seen: Seen[]; most: () => number }> {
    let now = 0;
    let most = 0;
    const provider = await fakeProvider((_, res) => {
      most = Math.max(most, ++now);
      setTimeout(() => {
        now--;
        streamed(res);
      }, ms);
    });
    return { ...provider, most: () => most };
  }

  it("holds a tenant to its concurrency and rate across two gateways", async () => {
    const provider = await slowProvider(100);
    const state = { redis: REDIS!, prefix: prefix() };
    const limits = { maxWaitMs: 10_000, tenantDefaults: { concurrent: 2 }, tenants: { slow: { requestsPerMinute: 120, burst: 1 } } };
    const [a, b] = [await gateway(provider.url, { state, limits }), await gateway(provider.url, { state, limits })];
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => ask(i % 2 ? a : b, token(), `r${i}`)));
    assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));
    assert.equal(provider.most(), 2, "never more than the tenant's 2 upstream at once, through both");

    // One request each half second, through either: of three at once, the third waits past maxWaitMs.
    const limited = { ...limits, maxWaitMs: 700 };
    const [c, d] = [await gateway(provider.url, { state, limits: limited }), await gateway(provider.url, { state, limits: limited })];
    const statuses = await Promise.all([c, d, c].map(async (gw) => (await ask(gw, token({ tenant: "slow" }))).status));
    assert.deepEqual(statuses.sort(), [200, 200, 429]);
  });

  it("counts a task's spending once for all gateways, and keeps it through a restart", async () => {
    const provider = await fakeProvider();
    const state = { redis: REDIS!, prefix: prefix() };
    const [a, b] = [await gateway(provider.url, { state }), await gateway(provider.url, { state })];
    // Each reply costs $0.00007: two, one through each, spend the task's $0.0001.
    const credential = token({ task: "capped", budgetUsd: 0.0001 });
    assert.deepEqual([(await ask(a, credential)).status, (await ask(b, credential)).status, (await ask(a, credential)).status], [200, 200, 402]);
    const read = (gw: Gateway) => fetch(`${gw.url}/usage/capped`, { headers: { "x-api-key": credential } }).then((r) => r.json());
    assert.deepEqual([(await read(b)).requests, (await read(b)).usage.output], [2, 10]);
    await a.close();
    await b.close();
    const again = await gateway(provider.url, { state });
    assert.equal((await read(again)).requests, 2);
    assert.equal((await ask(again, credential)).status, 402);
    assert.equal(provider.seen.length, 2);
    // Another tenant's task of the same id is another task.
    assert.equal((await ask(again, token({ tenant: "rival", task: "capped", budgetUsd: 0.0001 }))).status, 200);
    const shared = new RedisState(REDIS!, { prefix: state.prefix });
    closing.push(() => shared.close());
    assert.deepEqual([(await shared.spentOn("acme", utcDay()))?.requests, (await shared.spentOn("rival", utcDay()))?.requests], [2, 1]);
  });

  it("gets back the slot of a gateway that died with it when its lease ends, and renews a live one's", async () => {
    const provider = await fakeProvider();
    const state = { redis: REDIS!, prefix: prefix(), leaseMs: 300 };
    // Of the tenant's two slots, a replica took one and died without giving it back, and a live one holds
    // the other, renewing it, so the tenant's leases never go idle long enough to expire as a whole.
    const two = { tenant: { concurrent: 2 }, global: {} };
    const crashed = new RedisState(REDIS!, { prefix: state.prefix, leaseMs: 300 });
    assert.equal(await crashed.admit("acme", "crashed", two), 0);
    crashed.close();
    const live = new RedisState(REDIS!, { prefix: state.prefix, leaseMs: 300 });
    closing.push(() => live.close());
    assert.equal(await live.admit("acme", "live", two), 0);
    const renewing = setInterval(() => void live.renew("acme", "live"), 100);
    closing.push(() => clearInterval(renewing));
    const gw = await gateway(provider.url, { state, limits: { maxWaitMs: 3000, tenantDefaults: two.tenant } });
    const start = Date.now();
    assert.equal((await ask(gw, token())).status, 200);
    assert.ok(Date.now() - start >= 200, `it waited for the lease to end (${Date.now() - start} ms)`);
    const redis = new Redis(REDIS!);
    closing.push(() => redis.close());
    // The crashed lease is gone; this request's own goes once its reply is counted, just after its headers.
    const leases = () => redis.command(["ZRANGE", `${state.prefix}inflight:acme`, 0, -1]) as Promise<string[]>;
    assert.ok(!(await leases()).includes("crashed"), "the crashed lease ended");
    await until(async () => JSON.stringify(await leases()) === '["live"]', "only the live lease to be left");
    clearInterval(renewing);
    await live.release("acme", "live");

    const limits = { tenantDefaults: { concurrent: 1 } };

    // A reply that streams for three leases keeps its slot all along.
    let finish!: () => void;
    const held = await fakeProvider((seen, res) => {
      if (!seen.body.includes("long")) return streamed(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      finish = () => res.end(messagesReply([{ text: "Done." }]));
    });
    const [a, b] = [await gateway(held.url, { state, limits }), await gateway(held.url, { state, limits })];
    const long = ask(a, token(), "long");
    await until(() => held.seen.length === 1, "the long request");
    const short = ask(b, token(), "short");
    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(held.seen.length, 1, "the other gateway's request waited for the slot");
    finish();
    await (await long).text();
    assert.equal((await short).status, 200);
    assert.equal(held.seen.length, 2);
  });

  it("shares which keys rest, by their hash", async () => {
    const provider = await fakeProvider((seen, res) => {
      if (seen.headers["x-api-key"] === "pool-key-1") return void res.writeHead(429, { "retry-after": "60" }).end();
      streamed(res);
    });
    const state = { redis: REDIS!, prefix: prefix() };
    const upstream = { baseUrl: provider.url, keyEnv: ["POOL_KEY_1", "POOL_KEY_2"] };
    const [a, b] = [await gateway(provider.url, { state, upstream }), await gateway(provider.url, { state, upstream })];
    assert.equal((await ask(a, token())).status, 200);
    assert.equal((await ask(b, token())).status, 200);
    // b never tried the key a found resting.
    assert.deepEqual(provider.seen.map((s) => s.headers["x-api-key"]), ["pool-key-1", "pool-key-2", "pool-key-2"]);
    const redis = new Redis(REDIS!);
    closing.push(() => redis.close());
    const names = (await redis.command(["KEYS", `${state.prefix}key:*`])) as string[];
    const stored = JSON.stringify([names, await redis.command(["MGET", ...names])]);
    assert.equal(names.length, 1);
    assert.ok(!stored.includes("pool-key"), `no key in Redis: ${stored}`);
    // A resting key's mark goes when its rest is over.
    const ttl = Number(await redis.command(["PTTL", names[0]]));
    assert.ok(ttl > 50_000 && ttl <= 60_000, `it expires with the rest: ${ttl} ms`);
  });

  it("keeps each key's mark for itself: a refused one for a day, and then, or once removed, it is tried again", async () => {
    const marks = prefix();
    const shared = new RedisState(REDIS!, { prefix: marks });
    closing.push(() => shared.close());
    const redis = new Redis(REDIS!);
    closing.push(() => redis.close());
    // A refused key's mark keeps its own day, whatever other keys go through.
    await shared.markKey("k1", "bad");
    assert.ok(Number(await redis.command(["TTL", `${marks}key:k1`])) > 86_000);
    await redis.command(["EXPIRE", `${marks}key:k1`, 5]); // as if the day were nearly over
    await shared.markKey("k2", Date.now() + 60_000);
    await shared.markKey("k1", Date.now() + 60_000); // a rest doesn't undo a refusal, nor extend it
    assert.ok(Number(await redis.command(["TTL", `${marks}key:k1`])) <= 5);
    assert.deepEqual((await shared.keys(["k1", "k3"])).map((key) => key.bad), [true, false]);

    // A gateway that saw the provider refuse a key tries it again once its mark is gone.
    let refuse = true;
    const provider = await fakeProvider((seen, res) => {
      if (seen.headers["x-api-key"] === "pool-key-1" && refuse) return void res.writeHead(403).end();
      streamed(res);
    });
    const state = { redis: REDIS!, prefix: prefix() };
    const gw = await gateway(provider.url, { state, upstream: { baseUrl: provider.url, keyEnv: ["POOL_KEY_1", "POOL_KEY_2"] } });
    for (let i = 0; i < 2; i++) assert.equal((await ask(gw, token())).status, 200);
    assert.deepEqual(provider.seen.map((s) => s.headers["x-api-key"]), ["pool-key-1", "pool-key-2", "pool-key-2"]);
    // The operator put the key right and removed its mark, by the first 16 hex digits of its SHA-256.
    refuse = false;
    const id = createHash("sha256").update("pool-key-1").digest("hex").slice(0, 16);
    assert.equal(await redis.command(["DEL", `${state.prefix}key:${id}`]), 1);
    provider.seen.length = 0;
    for (let i = 0; i < 2; i++) assert.equal((await ask(gw, token())).status, 200);
    assert.deepEqual(provider.seen.map((s) => s.headers["x-api-key"]), ["pool-key-1", "pool-key-2"]);
  });

  it("answers 503 when Redis goes away mid-run, or goes on alone, and comes back with it", async () => {
    // Redis behind a proxy the test can cut.
    const target = new URL(REDIS!);
    const sockets = new Set<Socket>();
    let proxy: Server | undefined;
    const listen = async (port = 0) => {
      proxy = createTcpServer((socket) => {
        const upstream = connect(Number(target.port || 6379), target.hostname);
        for (const s of [socket, upstream]) {
          sockets.add(s);
          s.on("error", () => {}).on("close", () => (socket.destroy(), upstream.destroy(), sockets.delete(s)));
        }
        socket.pipe(upstream).pipe(socket);
      });
      await new Promise<void>((done) => proxy!.listen(port, "127.0.0.1", done));
      return (proxy.address() as AddressInfo).port;
    };
    const cut = async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => proxy!.close(done));
    };
    const port = await listen();
    closing.push(() => proxy?.listening && cut());
    const redis = `${target.protocol}//${target.username}${target.password ? `:${target.password}` : ""}@127.0.0.1:${port}${target.pathname}`;
    const provider = await fakeProvider();
    const prefixed = prefix();
    const closed = await gateway(provider.url, { state: { redis, prefix: prefixed } });
    const open = await gateway(provider.url, { state: { redis, prefix: prefixed, onStateError: "open" } });
    assert.deepEqual([(await ask(closed, token())).status, (await ask(open, token())).status], [200, 200]);
    await cut();
    const refused = await ask(closed, token());
    assert.deepEqual([refused.status, refused.headers.get("retry-after")], [503, "1"]);
    assert.equal((await ask(open, token())).status, 200);
    assert.equal(provider.seen.length, 3);
    await listen(port);
    await until(async () => (await ask(closed, token())).status === 200, "the gateway to reach Redis again");
  });
});
