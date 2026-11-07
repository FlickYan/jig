import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { costOf } from "../src/prices.ts";
import { Breaker, type Gateway, type GatewayConfig, startGateway, withModel } from "../server/gateway.ts";
import { Redis } from "../server/redis.ts";
import { MemoryState, RedisState, SharedState, utcDay } from "../server/state.ts";
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

async function gateway(upstream: string, config: Partial<GatewayConfig> = {}, env: NodeJS.ProcessEnv = {}, now?: () => number): Promise<Gateway> {
  const gw = await startGateway(
    { listen: { port: 0 }, metrics: { port: 0 }, upstream: { baseUrl: upstream, keyEnv: ["POOL_KEY_1"] }, ...config },
    { JIG_GATEWAY_SECRET: SECRET, ...KEYS, ...env },
    { now },
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

/** A clock the test moves, for the days and months a gateway counts spending by. */
function clock(start: number): { now: () => number; set(ms: number): void } {
  let time = start;
  return { now: () => time, set: (ms) => void (time = ms) };
}

const HOUR_MS = 60 * 60 * 1000;

/** A request's status and its retry-after, its body read so the reply is over. */
async function outcome(response: Promise<Response>): Promise<[number, string | null]> {
  const answered = await response;
  await answered.arrayBuffer();
  return [answered.status, answered.headers.get("retry-after")];
}

/** A series' value on the gateway's metrics listener. */
async function metric(gw: Gateway, series: string): Promise<number | undefined> {
  const text = await (await fetch(`${gw.metricsUrl}/metrics`)).text();
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
    await until(async () => provider.seen.length === 1 && (await metric(gw, "jig_gateway_waiting")) === 5, "the flood to queue up");
    const other = ask(gw, token({ tenant: "other", task: "o" }), "other");
    await until(async () => (await metric(gw, "jig_gateway_waiting")) === 6, "the other tenant's request to queue");
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
    assert.equal(await metric(revoked, 'jig_gateway_keys{upstream="default",state="refused"}'), 1);
  });

  it("counts the usage of streamed and whole replies, by task and tenant", async () => {
    const whole = { id: "m", type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: "Done." }], usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 20 } };
    const provider = await fakeProvider((seen, res) => {
      if (seen.body.includes("whole")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(whole));
      streamed(res);
    });
    const gw = await gateway(provider.url, { adminTokenEnv: "ADMIN_TOKEN" }, { ADMIN_TOKEN: "admin-secret" });
    const credential = token({ task: "t1" });
    const streamedReply = await ask(gw, credential, "streamed");
    assert.equal(streamedReply.headers.get("x-jig-upstream"), "default");
    assert.equal(await streamedReply.text(), messagesReply([{ text: "Done." }]));
    assert.deepEqual(await (await ask(gw, credential, "whole")).json(), whole);
    const usage = { input: 110, cacheRead: 1000, cacheWrite: 50, output: 25 };
    const costUsd = costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })! + costOf(MODEL, { input: 100, cacheRead: 1000, cacheWrite: 50, output: 20 })!;
    // One upstream given as `upstream` is named "default".
    const expected = { task: "t1", tenant: "acme", requests: 2, usage, costUsd, unpriced: 0, upstreams: { default: 2 }, budgetUsd: null };
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
    assert.deepEqual(await (await read("t1", token({ tenant: "rival" }))).json(), { ...expected, tenant: "rival", requests: 0, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, costUsd: 0, upstreams: {} });
    assert.equal((await read("t1?tenant=acme", token({ tenant: "rival" }))).status, 403);
    assert.equal((await read("%E0", credential)).status, 400);
    assert.equal(await metric(gw, 'jig_gateway_tokens_total{tenant="acme",kind="output"}'), 25);
    assert.equal(await metric(gw, 'jig_gateway_requests_total{tenant="acme",upstream="default",status="200"}'), 2);
    assert.equal(await metric(gw, 'jig_gateway_inflight{tenant="acme"}'), 0);
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
    await until(async () => (await metric(gw, 'jig_gateway_inflight{tenant="acme"}')) === 0, "the request to give back its slot");
    const spent = await (await fetch(`${gw.url}/usage/dropped`, { headers: { "x-api-key": token({ task: "dropped" }) } })).json();
    assert.deepEqual([spent.requests, spent.usage.input, spent.usage.output], [1, 10, 1]);
  });

  it("breaks off a reply the provider stops sending, once nothing has come for idleMs", async () => {
    // The provider sends its first event, 10 tokens in, then nothing, with the connection left open.
    const reply = messagesReply([{ text: "Done." }]);
    const provider = await fakeProvider((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(reply.slice(0, reply.indexOf("\n\n") + 2));
    });
    const gw = await gateway(provider.url, { failover: { idleMs: 200 } });
    const response = await ask(gw, token({ task: "stalled" }));
    assert.equal(response.status, 200);
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<string>((done) => (timer = setTimeout(() => done("hung"), 3000)));
    const outcome = await Promise.race([response.text().then(() => "ended", () => "broke off"), hung]).finally(() => clearTimeout(timer));
    assert.equal(outcome, "broke off");
    await until(async () => (await metric(gw, 'jig_gateway_inflight{tenant="acme"}')) === 0, "the request to give back its slot");
    const spent = await (await fetch(`${gw.url}/usage/stalled`, { headers: { "x-api-key": token({ task: "stalled" }) } })).json();
    assert.deepEqual([spent.requests, spent.usage.input], [1, 10]);
  });

  it("ends jig's reply only once it is counted, so the task's next request sees it", async () => {
    // Counting that takes a while, as a write to Redis can.
    const spend = MemoryState.prototype.spend;
    MemoryState.prototype.spend = async function (this: MemoryState, ...args: Parameters<MemoryState["spend"]>) {
      await new Promise((done) => setTimeout(done, 300));
      return spend.apply(this, args);
    };
    closing.push(() => (MemoryState.prototype.spend = spend));
    const provider = await fakeProvider();
    const gw = await gateway(provider.url);
    const credential = token({ task: "late" });
    await (await ask(gw, credential)).text();
    const spent = await (await fetch(`${gw.url}/usage/late`, { headers: { "x-api-key": credential } })).json();
    assert.equal(spent.requests, 1);
  });

  it("answers 402 once a task has spent its budget", async () => {
    const provider = await fakeProvider();
    const gw = await gateway(provider.url);
    // Each reply costs $0.00007 at claude-sonnet-5-5's price, so after two the task has spent its $0.0001.
    const credential = token({ task: "capped", budgetUsd: 0.0001 });
    assert.deepEqual([(await ask(gw, credential)).status, (await ask(gw, credential)).status], [200, 200]);
    const over = await ask(gw, credential);
    assert.equal(over.status, 402);
    const { error } = await over.json();
    assert.equal(error.type, "billing_error");
    // What it spent, not rounded down to look like the budget.
    assert.match(error.message, /\$0\.00014 of \$0\.0001\b/);
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

  it("refuses a tenant past its daily or monthly quota with 402 until the day or month is over", async () => {
    const provider = await fakeProvider();
    // Each reply costs $0.00007: two spend a quota of $0.0001, three one of $0.0002.
    const time = clock(Date.UTC(2026, 10, 29, 12));
    // Two replies spend these exactly: a quota spent to the cent is spent.
    const exact = 2 * costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })!;
    const tenants = { daily: { dailyUsd: 0.0001 }, monthly: { monthlyUsd: 0.0002 }, both: { dailyUsd: 0.0001, monthlyUsd: 0.0001 }, exactDay: { dailyUsd: exact }, exactMonth: { monthlyUsd: exact } };
    const gw = await gateway(provider.url, { limits: { tenants } }, {}, time.now);
    const as = (tenant: string) => ask(gw, token({ tenant }));
    assert.deepEqual([await outcome(as("daily")), await outcome(as("daily"))], [[200, null], [200, null]]);
    const over = await as("daily");
    assert.equal(over.status, 402);
    const { error } = await over.json();
    assert.equal(error.type, "billing_error");
    assert.equal(error.message, "This tenant has spent its daily quota: $0.00014 of $0.0001 today (UTC). It resets at 2026-11-30T00:00:00Z.");
    assert.equal(over.headers.get("retry-after"), String(12 * 60 * 60));
    assert.equal(provider.seen.length, 2);
    for (const tenant of ["exactDay", "exactMonth"]) {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await outcome(as(tenant)))[0]);
      assert.deepEqual(statuses, [200, 200, 402], tenant);
    }
    // A tenant without quotas goes on as before; the next day, the daily one does too.
    assert.deepEqual(await outcome(as("acme")), [200, null]);
    time.set(Date.UTC(2026, 10, 30, 0, 0, 1));
    assert.deepEqual(await outcome(as("daily")), [200, null]);

    // A month's quota is spent across its days, and holds until the next month.
    time.set(Date.UTC(2026, 10, 29, 12));
    assert.deepEqual(await outcome(as("monthly")), [200, null]);
    time.set(Date.UTC(2026, 10, 30, 18));
    assert.deepEqual([await outcome(as("monthly")), await outcome(as("monthly"))], [[200, null], [200, null]]);
    const month = await as("monthly");
    assert.deepEqual([month.status, month.headers.get("retry-after")], [402, String(6 * 60 * 60)]);
    assert.match((await month.json()).error.message, /monthly quota: \$0\.00021 of \$0\.0002 this month \(UTC\)\. It resets at 2026-12-01T00:00:00Z\./);
    time.set(Date.UTC(2026, 11, 1));
    assert.deepEqual(await outcome(as("monthly")), [200, null]);
    // With both spent, the month's is the one to wait for.
    time.set(Date.UTC(2026, 11, 31, 23));
    assert.deepEqual([await outcome(as("both")), await outcome(as("both"))], [[200, null], [200, null]]);
    const both = await as("both");
    assert.deepEqual([both.status, both.headers.get("retry-after")], [402, String(60 * 60)]);
    assert.match((await both.json()).error.message, /monthly quota.* 2027-01-01T00:00:00Z/);

    assert.equal(await metric(gw, 'jig_gateway_refused_total{tenant="daily",reason="quota"}'), 1);
    assert.equal(await metric(gw, 'jig_gateway_refused_total{tenant="monthly",reason="quota"}'), 1);
    assert.equal(await metric(gw, 'jig_gateway_requests_total{tenant="daily",upstream="none",status="402"}'), 1);
    // As with a budget, a quota needs a price to count against.
    const unpriced = await fetch(`${gw.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token({ tenant: "daily" }) }, body: body("hi", "claude-haiku-4-5") });
    assert.equal(unpriced.status, 400);
    assert.equal(provider.seen.length, 14);
  });

  it("holds a tenant whose id every object has as a name to the defaults' quota, as any other", async () => {
    const provider = await fakeProvider();
    const gw = await gateway(provider.url, { limits: { tenantDefaults: { dailyUsd: 0.0001 }, tenants: { named: { concurrent: 5 } } } });
    for (const tenant of ["constructor", "toString"]) {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await outcome(ask(gw, token({ tenant }))))[0]);
      assert.deepEqual(statuses, [200, 200, 402], tenant);
    }
  });

  it("says what is wrong with a quota before it starts", async () => {
    const start = (limits: GatewayConfig["limits"]) => gateway("http://127.0.0.1:9", { limits });
    await assert.rejects(start({ dailyUsd: 5 } as GatewayConfig["limits"]), /limits.dailyUsd is a tenant's quota/);
    await assert.rejects(start({ tenantDefaults: { monthlyUsd: 0 } }), /limits.tenantDefaults.monthlyUsd must be a number of USD above 0/);
    await assert.rejects(start({ tenants: { acme: { dailyUsd: "5" as unknown as number } } }), /limits.tenants.acme.dailyUsd/);
  });

  it("reads a tenant's spending by UTC day to the admin token, for billing", async () => {
    const provider = await fakeProvider();
    const time = clock(Date.UTC(2026, 10, 29, 23));
    const gw = await gateway(provider.url, { adminTokenEnv: "ADMIN_TOKEN" }, { ADMIN_TOKEN: "admin-secret" }, time.now);
    await outcome(ask(gw, token()));
    time.set(Date.UTC(2026, 10, 30, 1));
    await outcome(ask(gw, token({ task: "t2" })));
    await outcome(ask(gw, token({ task: "t3" })));
    await outcome(ask(gw, token({ tenant: "rival" })));
    const read = (query: string, credential = "admin-secret") => fetch(`${gw.url}/usage?${query}`, { headers: { authorization: `Bearer ${credential}` } });
    const cost = costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 })!;
    const day = (day: string, n: number) => ({ day, requests: n, input: 10 * n, output: 5 * n, cacheRead: 0, cacheWrite: 0, costUsd: n * cost });
    const days = await (await read("tenant=acme&from=2026-11-01&to=2026-12-31")).json();
    // Days with nothing spent are left out.
    assert.deepEqual({ ...days, total: { ...days.total, costUsd: undefined } }, {
      tenant: "acme",
      from: "2026-11-01",
      to: "2026-12-31",
      days: [day("2026-11-29", 1), day("2026-11-30", 2)],
      total: { requests: 3, input: 30, output: 15, cacheRead: 0, cacheWrite: 0, costUsd: undefined },
    });
    assert.ok(Math.abs(days.total.costUsd - 3 * cost) < 1e-12);
    assert.deepEqual((await (await read("tenant=acme&from=2026-11-30&to=2026-11-30")).json()).days, [day("2026-11-30", 2)]);
    assert.deepEqual((await (await read("tenant=rival&from=2026-11-30&to=2026-11-30")).json()).total.requests, 1);
    // A leap year's 366 days are a range; 367 aren't.
    assert.deepEqual((await (await read("tenant=acme&from=2024-01-01&to=2024-12-31")).json()).days, []);
    // Date.parse reads 2026-02-30 as 2026-03-02, so a `to` after that is what shows it refused as no day.
    for (const query of ["tenant=acme&from=2024-01-01&to=2025-01-01", "from=2026-11-01&to=2026-11-30", "tenant=acme&from=2026-02-30&to=2026-03-05", "tenant=acme&from=2026-11-1&to=2026-11-30", "tenant=acme&to=2026-11-30", "tenant=acme&from=2026-11-30&to=2026-11-29"]) {
      const response = await read(query);
      const { error } = await response.json();
      assert.deepEqual([response.status, error.type], [400, "invalid_request_error"], query);
      if (query.includes("02-30")) assert.match(error.message, /must be days/);
    }
    // Only to the admin token: a task's token reads its own task's, at /usage/<task>, as before.
    assert.equal((await read("tenant=acme&from=2026-11-01&to=2026-11-30", token())).status, 403);
    assert.equal((await read("tenant=acme&from=2026-11-01&to=2026-11-30", "wrong")).status, 401);
    assert.equal((await (await fetch(`${gw.url}/usage/t1`, { headers: { "x-api-key": token() } })).json()).requests, 1);
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

  it("ends a jig run whose tenant spends its quota, which jig's SDK doesn't retry", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "write_file", input: { path: "done.txt", content: "done\n" } }] : [{ text: "Done." }]));
    closing.push(() => api.close());
    // The first reply spends more than the day's quota, so the run's second request is refused.
    const gw = await gateway(api.url, { limits: { tenantDefaults: { dailyUsd: 0.00001 } } });
    const cwd = await tempDir("jig-gateway-");
    const args = ["--no-sandbox", "--yes", "--model", MODEL, "--base-url", `${gw.url}/anthropic`, "Write done.txt."];
    const { code, output } = await runJig(args, { api, cwd, env: { ANTHROPIC_API_KEY: token({ task: "quota-run" }) } });
    assert.equal(code, 1, output);
    assert.match(output, /daily quota/);
    assert.equal(api.requests.length, 1);
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

describe("the gateway with several upstreams", () => {
  const overloaded = (res: ServerResponse) => void res.writeHead(529, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

  /** A gateway with these upstreams, in this order, each with the key POOL_KEY_1. */
  async function failover(upstreams: { name: string; url: string; models?: Record<string, string> }[], config: Partial<GatewayConfig> = {}): Promise<Gateway> {
    const listed = upstreams.map(({ name, url, models }) => ({ name, baseUrl: url, keyEnv: ["POOL_KEY_1"], models }));
    const gw = await startGateway({ listen: { port: 0 }, metrics: { port: 0 }, upstreams: listed, ...config }, { JIG_GATEWAY_SECRET: SECRET, ...KEYS });
    closing.push(() => gw.close());
    return gw;
  }

  /** A request for `model`, as ask() makes one for the default. */
  function askFor(gw: Gateway, credential: string, model: string): Promise<Response> {
    return fetch(`${gw.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": credential }, body: body("hi", model) });
  }

  // A per-test timeout, so an upstream that never answers fails the test rather than hanging the run.
  it("goes on to the next upstream when one is overloaded, failing, unreachable, slow or refuses its keys", { timeout: 15_000 }, async () => {
    const second = await fakeProvider();
    const firsts = {
      overloaded: await fakeProvider((_, res) => overloaded(res)),
      failing: await fakeProvider((_, res) => void res.writeHead(500).end("oops")),
      unreachable: { url: `http://127.0.0.1:${await deadPort()}`, seen: [] },
      slow: await fakeProvider(() => {}), // never answers
      // Sends an error's headers, then never ends its body.
      slowError: await fakeProvider((_, res) => void res.writeHead(529, { "content-type": "application/json" }).write('{"type":"err')),
      refusing: await fakeProvider((_, res) => void res.writeHead(401).end()),
    };
    const reasons: Record<string, string> = { overloaded: "status_529", failing: "status_500", unreachable: "connect", slow: "timeout", slowError: "timeout", refusing: "keys" };
    for (const [what, first] of Object.entries(firsts)) {
      const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }], { failover: { firstByteMs: 300 } });
      const credential = token({ task: what });
      const response = await ask(gw, credential);
      assert.deepEqual([response.status, response.headers.get("x-jig-upstream")], [200, "second"], what);
      assert.equal(await response.text(), messagesReply([{ text: "Done." }]));
      const spent = await (await fetch(`${gw.url}/usage/${what}`, { headers: { "x-api-key": credential } })).json();
      assert.deepEqual([spent.requests, spent.upstreams], [1, { second: 1 }], what);
      assert.equal(await metric(gw, `jig_gateway_failovers_total{from="first",to="second",reason="${reasons[what]}"}`), 1, what);
      if (what !== "unreachable") assert.equal(first.seen.length, 1, `${what}: the first upstream was asked`);
    }
    // Each went to the second as it came.
    assert.equal(second.seen.length, Object.keys(firsts).length);
    for (const seen of second.seen) assert.ok(seen.body.equals(Buffer.from(body())));
  });

  it("gives a bad request's reply back as it is, and fails no other over", async () => {
    const first = await fakeProvider((_, res) => void res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'));
    const second = await fakeProvider();
    const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }]);
    const response = await ask(gw, token());
    assert.deepEqual([response.status, response.headers.get("x-jig-upstream")], [400, "first"]);
    assert.equal((await response.json()).error.message, "bad");
    assert.equal(second.seen.length, 0);
  });

  it("breaks off a reply that fails once it streams, rather than sending the request again", async () => {
    const reply = messagesReply([{ text: "Done." }]);
    const first = await fakeProvider((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(reply.slice(0, reply.indexOf("\n\n") + 2), () => setTimeout(() => res.socket?.destroy(), 50));
    });
    const second = await fakeProvider();
    const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }]);
    const response = await ask(gw, token());
    assert.deepEqual([response.status, response.headers.get("x-jig-upstream")], [200, "first"]);
    await assert.rejects(response.text(), "jig sees the break");
    assert.equal(second.seen.length, 0);
  });

  it("answers with the last failure when every upstream fails, or 503 when none answered", async () => {
    const first = await fakeProvider((_, res) => overloaded(res));
    const second = await fakeProvider((_, res) => void res.writeHead(500, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"api_error","message":"second failed"}}'));
    const both = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }]);
    const failed = await ask(both, token());
    assert.deepEqual([failed.status, failed.headers.get("x-jig-upstream")], [500, "second"]);
    assert.equal((await failed.json()).error.message, "second failed");
    // The failed reply passed back is timed to its headers, as one that streams is.
    assert.equal(await metric(both, 'jig_gateway_first_byte_seconds_count{upstream="second"}'), 1);

    const dead = `http://127.0.0.1:${await deadPort()}`;
    const none = await failover([{ name: "first", url: dead }, { name: "second", url: dead }]);
    const unanswered = await ask(none, token());
    assert.equal(unanswered.status, 503);
    const { error } = await unanswered.json();
    assert.equal(error.type, "overloaded_error");
    assert.match(error.message, /first: could not reach .*; second: could not reach/);
  });

  it("opens an upstream's circuit after failures in a row, passes it over, then lets one probe through", async () => {
    let mode: "fail" | "hold" | "ok" = "fail";
    const held: ServerResponse[] = [];
    const first = await fakeProvider((_, res) => (mode === "fail" ? overloaded(res) : mode === "hold" ? void held.push(res) : streamed(res)));
    const second = await fakeProvider();
    const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }], { failover: { failures: 2, openMs: 300 } });
    const via = async (content: string) => {
      const response = await ask(gw, token(), content);
      await response.text();
      return response.headers.get("x-jig-upstream");
    };
    assert.deepEqual([await via("a"), await via("b")], ["second", "second"]);
    assert.equal(first.seen.length, 2);
    // Open: no request reaches the first.
    assert.equal(await via("c"), "second");
    assert.equal(first.seen.length, 2);
    // Once openMs is over, one request tries it; that one fails, and the circuit opens again.
    await sleep(350);
    assert.equal(await via("d"), "second");
    assert.equal(await via("e"), "second");
    assert.equal(first.seen.length, 3);
    // The first is back. While the probe waits for its reply, the other requests still pass it over.
    await sleep(350);
    mode = "hold";
    const probe = ask(gw, token(), "probe");
    await until(() => first.seen.length === 4, "the probe");
    assert.equal(await via("f"), "second");
    assert.equal(first.seen.length, 4);
    mode = "ok";
    held.forEach((res) => streamed(res));
    const probed = await probe;
    assert.equal(probed.headers.get("x-jig-upstream"), "first");
    await probed.text();
    // Closed: the first takes requests again.
    assert.deepEqual([await via("g"), await via("h")], ["first", "first"]);
    assert.equal(await metric(gw, 'jig_gateway_failovers_total{from="first",to="second",reason="status_529"}'), 3);

    // With every upstream's circuit open, nothing is sent, and jig is told when to try again.
    const lone = await fakeProvider((_, res) => overloaded(res));
    const alone = await failover([{ name: "lone", url: lone.url }], { failover: { failures: 1, openMs: 5000 } });
    assert.equal((await ask(alone, token())).status, 529);
    const open = await ask(alone, token());
    assert.deepEqual([open.status, (await open.json()).error.type, lone.seen.length], [503, "overloaded_error", 1]);
    assert.ok(Number(open.headers.get("retry-after")) >= 1);
  });

  it("leaves the circuit to the keys when the provider rate-limits: a resting key passes it over for its retry-after alone", async () => {
    let limited = 0;
    const provider = await fakeProvider((_, res) => {
      if (limited++) return streamed(res);
      res.writeHead(429, { "retry-after": "1", "content-type": "application/json" }).end('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}');
    });
    // One upstream, as `upstream`: the provider's 429, then the gateway's own while the key rests, more than `failures` of them.
    const gw = await gateway(provider.url, { failover: { failures: 2, openMs: 30_000 } });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const response = await ask(gw, token());
      statuses.push([response.status, response.headers.get("retry-after")]);
      await response.text();
    }
    assert.deepEqual(statuses, [[429, "1"], [429, "1"], [429, "1"], [429, "1"]]);
    assert.equal(provider.seen.length, 1);
    // A second later the key is back, and so is the provider: no circuit holds it for openMs.
    await sleep(1100);
    const back = await ask(gw, token());
    assert.deepEqual([back.status, back.headers.get("x-jig-upstream")], [200, "default"]);
    await back.text();
    assert.equal(provider.seen.length, 2);

    // With several upstreams, the requests go on to the next while the key rests, and back to the first after.
    limited = 0;
    const second = await fakeProvider();
    const both = await failover([{ name: "first", url: provider.url }, { name: "second", url: second.url }], { failover: { failures: 2, openMs: 30_000 } });
    const via = async () => {
      const response = await ask(both, token());
      await response.text();
      return response.headers.get("x-jig-upstream");
    };
    assert.deepEqual([await via(), await via(), await via(), await via()], ["second", "second", "second", "second"]);
    assert.equal(provider.seen.length, 3);
    await sleep(1100);
    assert.equal(await via(), "first");
  });

  it("closes the circuit on a probe's 400, which is the upstream answering", async () => {
    let mode: "fail" | "bad" | "ok" = "fail";
    const first = await fakeProvider((_, res) => {
      if (mode === "fail") return overloaded(res);
      if (mode === "bad") return void res.writeHead(400, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}');
      streamed(res);
    });
    const second = await fakeProvider();
    const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }], { failover: { failures: 1, openMs: 200 } });
    await (await ask(gw, token())).text();
    assert.equal(await metric(gw, 'jig_gateway_upstream_open{upstream="first"}'), 1);
    await sleep(250);
    mode = "bad";
    const probe = await ask(gw, token());
    assert.deepEqual([probe.status, probe.headers.get("x-jig-upstream")], [400, "first"]);
    await probe.text();
    mode = "ok";
    const next = await ask(gw, token());
    assert.equal(next.headers.get("x-jig-upstream"), "first");
    await next.text();
    assert.equal(await metric(gw, 'jig_gateway_upstream_open{upstream="first"}'), 0);
    assert.equal(first.seen.length, 3);
  });

  it("frees the probe of a client that went away, so the next request probes", async () => {
    let mode: "fail" | "hold" | "ok" = "fail";
    const held: ServerResponse[] = [];
    const first = await fakeProvider((_, res) => (mode === "fail" ? overloaded(res) : mode === "hold" ? void held.push(res) : streamed(res)));
    const second = await fakeProvider();
    const gw = await failover([{ name: "first", url: first.url }, { name: "second", url: second.url }], { failover: { failures: 1, openMs: 200 } });
    await (await ask(gw, token())).text();
    await sleep(250);
    mode = "hold";
    const client = new AbortController();
    const probe = fetch(`${gw.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token() }, body: body("probe"), signal: client.signal });
    await until(() => first.seen.length === 2, "the probe");
    client.abort();
    await assert.rejects(probe);
    await until(() => held[0].closed, "the gateway to give up the probe");
    mode = "ok";
    const next = await ask(gw, token());
    assert.equal(next.headers.get("x-jig-upstream"), "first");
    await next.text();
    assert.equal(first.seen.length, 3);
  });

  it("lets one probe through at a time, and another once the probe's client went away", () => {
    const breaker = new Breaker(1, 100);
    assert.equal(breaker.take(0), "closed");
    assert.equal(breaker.failed("closed", 0), true);
    assert.equal(breaker.take(50), undefined);
    assert.equal(breaker.take(100), "probe");
    assert.equal(breaker.take(100), undefined);
    breaker.abandoned("probe");
    assert.equal(breaker.take(100), "probe");
    assert.equal(breaker.succeeded(), true);
    assert.equal(breaker.take(100), "closed");
  });

  it("closes on any reply, a late one to a request sent before the circuit opened included", () => {
    const breaker = new Breaker(1, 100);
    assert.equal(breaker.take(0), "closed"); // its reply comes late
    assert.equal(breaker.take(0), "closed");
    assert.equal(breaker.failed("closed", 10), true);
    assert.equal(breaker.take(20), undefined);
    assert.equal(breaker.succeeded(), true);
    assert.equal(breaker.take(20), "closed");
  });

  it("sends each model to the upstreams that serve it, under the provider's id, and refuses one none serves", async () => {
    const anthropic = await fakeProvider();
    const deepseek = await fakeProvider();
    const gw = await failover([
      { name: "anthropic", url: anthropic.url, models: { [MODEL]: "claude-sonnet-5-5-20261001" } },
      { name: "deepseek", url: deepseek.url, models: { "deepseek-flash": "deepseek-v4-pro" } },
    ]);
    const claude = await askFor(gw, token({ task: "claude" }), MODEL);
    assert.deepEqual([claude.status, claude.headers.get("x-jig-upstream")], [200, "anthropic"]);
    await claude.text();
    // Only the model changed, the rest of the body byte for byte.
    assert.equal(anthropic.seen[0].body.toString(), body().replace(`"model":"${MODEL}"`, '"model":"claude-sonnet-5-5-20261001"'));
    const flash = await askFor(gw, token({ task: "flash" }), "deepseek-flash");
    assert.deepEqual([flash.status, flash.headers.get("x-jig-upstream")], [200, "deepseek"]);
    await flash.text();
    assert.equal(JSON.parse(deepseek.seen[0].body.toString()).model, "deepseek-v4-pro");
    // Priced by the provider's id where it has a price, else by the model jig asked for.
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
    const spent = async (task: string) => (await fetch(`${gw.url}/usage/${task}`, { headers: { "x-api-key": token({ task }) } })).json();
    assert.equal((await spent("flash")).costUsd, costOf("deepseek-v4-pro", usage));
    assert.equal((await spent("claude")).costUsd, costOf(MODEL, usage));

    const unserved = await askFor(gw, token(), "gpt-9");
    assert.equal(unserved.status, 400);
    const { error } = await unserved.json();
    assert.equal(error.type, "invalid_request_error");
    assert.match(error.message, /gpt-9/);
    assert.equal(anthropic.seen.length + deepseek.seen.length, 2);
  });

  it("holds a budget or a quota to a model priced at every upstream that serves it, by jig's id or the provider's", async () => {
    const provider = await fakeProvider();
    const quota = { limits: { tenants: { capped: { dailyUsd: 1 } } } };
    // An alias the upstream maps to a priced id is priced, so a budget and a quota can count it.
    const aliased = await failover([{ name: "a", url: provider.url, models: { "my-alias": MODEL } }], quota);
    const credential = token({ task: "alias", budgetUsd: 1 });
    const response = await askFor(aliased, credential, "my-alias");
    assert.equal(response.status, 200);
    await response.text();
    const spent = await (await fetch(`${aliased.url}/usage/alias`, { headers: { "x-api-key": credential } })).json();
    assert.equal(spent.costUsd, costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }));
    assert.equal((await outcome(askFor(aliased, token({ tenant: "capped" }), "my-alias")))[0], 200);
    // An upstream that would send it on as it is, with no price, could be failed over to: refused.
    const both = await failover([{ name: "a", url: provider.url, models: { "my-alias": MODEL } }, { name: "b", url: provider.url }], quota);
    for (const credential of [token({ budgetUsd: 1 }), token({ tenant: "capped" })]) {
      const refused = await askFor(both, credential, "my-alias");
      assert.equal(refused.status, 400);
      assert.match((await refused.json()).error.message, /with a price/);
    }
    // Nor is a name every object has a price.
    assert.equal((await outcome(askFor(both, token({ budgetUsd: 1 }), "constructor")))[0], 400);
    assert.equal(provider.seen.length, 2);
  });

  it("sets only the top-level model of a body, the rest byte for byte", () => {
    const raw = '{"system":"a \\"}{ \\"model\\":\\"x\\"","messages":[{"role":"user","content":{"model":"x"}}], "model" : "a", "metadata":{"model":"y"}, "é":1}';
    assert.equal(withModel(Buffer.from(raw), "b").toString(), raw.replace('"model" : "a"', '"model" : "b"'));
    // A key it can't see for its escapes is set all the same.
    assert.equal(JSON.parse(withModel(Buffer.from('{"mod\\u0065l":"a","max_tokens":1}'), "b").toString()).model, "b");
  });

  it("says what is wrong with its upstreams before it starts", async () => {
    const one = { baseUrl: "http://127.0.0.1:9", keyEnv: ["POOL_KEY_1"] };
    const start = (config: Partial<GatewayConfig>) => startGateway({ listen: { port: 0 }, ...config }, { JIG_GATEWAY_SECRET: SECRET, ...KEYS });
    await assert.rejects(start({ upstream: one, upstreams: [{ name: "a", ...one }] }), /not both/);
    await assert.rejects(start({}), /Set upstream, or upstreams/);
    await assert.rejects(start({ upstreams: [{ name: "Big Name", ...one }] }), /upstreams\[0\]\.name/);
    await assert.rejects(start({ upstreams: [{ name: "a", ...one }, { name: "a", ...one }] }), /two upstreams are named a/);
    await assert.rejects(start({ upstreams: [{ name: "a", ...one, models: { x: 1 as unknown as string } }] }), /models must map/);
    // An empty map would serve no model at all.
    await assert.rejects(start({ upstreams: [{ name: "a", ...one, models: {} }] }), /models must map at least one/);
    await assert.rejects(start({ upstreams: [{ name: "a", ...one, keyEnv: ["NOWHERE"] }] }), /No key in NOWHERE/);
    await assert.rejects(start({ upstream: one, failover: { failures: 0 } }), /failover.failures/);
  });
});

describe("the gateway's metrics and logs", () => {
  const overloaded = (res: ServerResponse) => void res.writeHead(529, { "content-type": "application/json" }).end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');

  it("serves its metrics on a listener of its own, which serves nothing else, and none without one", async () => {
    const provider = await fakeProvider();
    const plain = await gateway(provider.url, { metrics: undefined });
    assert.equal(plain.metricsUrl, undefined);
    assert.equal((await fetch(`${plain.url}/metrics`)).status, 404);
    const gw = await gateway(provider.url);
    assert.equal((await fetch(`${gw.url}/metrics`)).status, 404, "never on the public port");
    assert.notEqual(new URL(gw.metricsUrl!).port, new URL(gw.url).port);
    assert.equal(await (await fetch(`${gw.metricsUrl}/healthz`)).text(), "ok\n");
    const scrape = await fetch(`${gw.metricsUrl}/metrics`);
    assert.match(scrape.headers.get("content-type")!, /^text\/plain; version=0\.0\.4/);
    assert.match(await scrape.text(), /# TYPE jig_gateway_refused_total counter/);
    for (const [method, path] of [["POST", "/metrics"], ["GET", "/usage/t1"], ["POST", "/anthropic/v1/messages"]]) {
      const response = await fetch(`${gw.metricsUrl}${path}`, { method, headers: { "x-api-key": token() }, body: method === "POST" ? body() : undefined });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal(provider.seen.length, 0);
    await assert.rejects(gateway(provider.url, { metrics: { port: -1 } }), /metrics.port/);
  });

  it("answers a request target that is no URL on either listener, and keeps serving", async () => {
    const provider = await fakeProvider();
    const gw = await gateway(provider.url);
    let uncaught: unknown;
    const hook = (err: unknown) => (uncaught = err);
    process.on("uncaughtException", hook);
    try {
      // fetch() cannot send this target, so it goes over a socket as it is.
      const raw = (url: string) =>
        new Promise<string>((done, failed) => {
          const { hostname, port } = new URL(url);
          const socket = connect(Number(port), hostname, () => socket.end("GET http://[x/ HTTP/1.1\r\nhost: gateway\r\nconnection: close\r\n\r\n"));
          let reply = "";
          socket.setEncoding("utf8").on("data", (chunk) => (reply += chunk)).on("error", failed).on("close", () => done(reply));
        });
      assert.match(await raw(gw.metricsUrl!), /^HTTP\/1\.1 400 /);
      assert.match(await raw(gw.url), /^HTTP\/1\.1 500 /);
    } finally {
      process.off("uncaughtException", hook);
    }
    assert.equal(uncaught, undefined);
    for (const url of [gw.url, gw.metricsUrl]) assert.equal(await (await fetch(`${url}/healthz`)).text(), "ok\n");
  });

  it("counts calls by status and upstream, their tokens, cost, refusals and failovers", async () => {
    const first = await fakeProvider((_, res) => overloaded(res));
    const second = await fakeProvider();
    const upstreams = [{ name: "first", baseUrl: first.url, keyEnv: ["POOL_KEY_1"] }, { name: "second", baseUrl: second.url, keyEnv: ["POOL_KEY_1", "POOL_KEY_2"] }];
    const gw = await gateway("", { upstream: undefined, upstreams, failover: { failures: 1, openMs: 60_000 } });
    // The first fails over to the second, and its circuit opens: the next goes to the second alone.
    for (const task of ["a", "b"]) {
      const response = await ask(gw, token({ task }));
      assert.deepEqual([response.status, response.headers.get("x-jig-upstream")], [200, "second"]);
      await response.text();
    }
    assert.equal(first.seen.length, 1);
    assert.equal((await ask(gw, "not-a-token")).status, 401);
    assert.equal((await ask(gw, token({ task: "broke", budgetUsd: 0 }))).status, 402);
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
    const expected: [string, number][] = [
      ['jig_gateway_requests_total{tenant="acme",upstream="second",status="200"}', 2],
      ['jig_gateway_requests_total{tenant="none",upstream="none",status="401"}', 1],
      ['jig_gateway_requests_total{tenant="acme",upstream="none",status="402"}', 1],
      ['jig_gateway_refused_total{tenant="none",reason="auth"}', 1],
      ['jig_gateway_refused_total{tenant="acme",reason="budget"}', 1],
      ['jig_gateway_failovers_total{from="first",to="second",reason="status_529"}', 1],
      ['jig_gateway_tokens_total{tenant="acme",kind="input"}', 20],
      ['jig_gateway_tokens_total{tenant="acme",kind="output"}', 10],
      ['jig_gateway_cost_usd_total{tenant="acme"}', 2 * costOf(MODEL, usage)!],
      ['jig_gateway_request_seconds_count{upstream="second"}', 2],
      ['jig_gateway_request_seconds_count{upstream="none"}', 2],
      ['jig_gateway_first_byte_seconds_count{upstream="second"}', 2],
      ['jig_gateway_queue_seconds_count{tenant="acme"}', 2],
      ['jig_gateway_inflight{tenant="acme"}', 0],
      ["jig_gateway_waiting", 0],
      ['jig_gateway_upstream_open{upstream="first"}', 1],
      ['jig_gateway_upstream_open{upstream="second"}', 0],
      ['jig_gateway_keys{upstream="first",state="ok"}', 1],
      ['jig_gateway_keys{upstream="second",state="ok"}', 2],
      ["jig_gateway_state_errors_total", 0],
    ];
    await until(async () => (await metric(gw, 'jig_gateway_request_seconds_count{upstream="none"}')) === 2, "every call to be counted");
    for (const [series, value] of expected) assert.equal(await metric(gw, series), value, series);
    const text = await (await fetch(`${gw.metricsUrl}/metrics`)).text();
    assert.match(text, /# TYPE jig_gateway_request_seconds histogram/);
    assert.ok(!/pool-key|jgt1\.|"broke"/.test(text), "no key, token or task in a label");

    // Over the tenant's requests in flight, and over its rate: refused, each for what it is.
    const held: ServerResponse[] = [];
    let hold = true;
    const holding = await fakeProvider((_, res) => (hold ? void held.push(res) : streamed(res)));
    const limited = await gateway(holding.url, { limits: { maxWaitMs: 200, tenants: { one: { concurrent: 1 }, slow: { requestsPerMinute: 1 } } } });
    const busy = ask(limited, token({ tenant: "one" }));
    await until(() => held.length === 1, "the first request to be held");
    assert.equal((await ask(limited, token({ tenant: "one" }))).status, 429);
    assert.equal(await metric(limited, 'jig_gateway_inflight{tenant="one"}'), 1);
    hold = false;
    held.forEach((res) => streamed(res));
    await (await busy).text();
    assert.equal((await ask(limited, token({ tenant: "slow" }))).status, 200);
    assert.equal((await ask(limited, token({ tenant: "slow" }))).status, 429);
    assert.equal(await metric(limited, 'jig_gateway_refused_total{tenant="one",reason="concurrency"}'), 1);
    assert.equal(await metric(limited, 'jig_gateway_refused_total{tenant="slow",reason="rate"}'), 1);
  });

  it("counts a call jig left before any reply as 499", async () => {
    const provider = await fakeProvider(() => {}); // holds its reply
    const gw = await gateway(provider.url);
    const client = new AbortController();
    const left = fetch(`${gw.url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token() }, body: body(), signal: client.signal });
    await until(() => provider.seen.length === 1, "the call to reach the provider");
    client.abort();
    await assert.rejects(left);
    await until(async () => (await metric(gw, 'jig_gateway_requests_total{tenant="acme",upstream="none",status="499"}')) === 1, "the call to be counted as 499");
  });

  it("answers with the client's x-request-id or a new one, which the provider never sees", async () => {
    const provider = await fakeProvider((_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_provider", "x-request-id": "the-providers" });
      res.end(messagesReply([{ text: "Done." }]));
    });
    const gw = await gateway(provider.url);
    const traced = await ask(gw, token(), "hi", { "x-request-id": "trace-1.a_B" });
    assert.equal(traced.headers.get("x-request-id"), "trace-1.a_B");
    assert.equal(traced.headers.get("request-id"), "req_provider", "the provider's own id comes back too");
    await traced.text();
    const made = await ask(gw, token(), "hi", { "x-request-id": "not an id!" });
    const id = made.headers.get("x-request-id")!;
    assert.match(id, /^[\w.-]{1,128}$/);
    await made.text();
    assert.equal(provider.seen.length, 2);
    assert.ok(provider.seen.every((seen) => seen.headers["x-request-id"] === undefined), "not sent upstream");
    // On every reply: a refusal, another route, and the metrics listener's.
    const refused = await ask(gw, "nope");
    assert.match(refused.headers.get("x-request-id")!, /^[\w.-]{1,128}$/);
    assert.notEqual(refused.headers.get("x-request-id"), id);
    const elsewhere = [await fetch(`${gw.url}/nowhere`, { headers: { "x-request-id": "r2" } }), await fetch(`${gw.metricsUrl}/metrics`, { headers: { "x-request-id": "r3" } })];
    assert.deepEqual(elsewhere.map((r) => r.headers.get("x-request-id")), ["r2", "r3"]);
    await Promise.all([refused, ...elsewhere].map((r) => r.arrayBuffer()));
  });

  it("writes JSON log lines, a model call's at debug with its request id and the provider's", async () => {
    const reply = messagesReply([{ text: "Done." }]);
    const provider = await fakeProvider((seen, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_upstream_1" });
      // A reply that stops after its first event, 10 tokens in and 1 out, which jig then leaves.
      if (seen.body.includes("half")) return void res.write(reply.slice(0, reply.indexOf("\n\n") + 2));
      res.end(reply);
    });
    const dir = await tempDir("jig-gateway-");
    const config = join(dir, "gateway.json");
    await writeFile(config, JSON.stringify({ listen: { port: 0 }, metrics: { port: 0 }, upstream: { baseUrl: provider.url, keyEnv: ["POOL_KEY_1"] } }));
    const env = { PATH: process.env.PATH, JIG_GATEWAY_SECRET: SECRET, ...KEYS, JIG_LOG_FORMAT: "json", JIG_LOG_LEVEL: "debug" };
    const child = spawn(process.execPath, [join(ROOT, "server", "gateway.ts"), "--config", config], { env });
    closing.push(() => child.kill());
    const exited = new Promise<number | null>((done) => child.on("exit", done));
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const lines = () => stderr.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    await until(() => lines().some((line) => /^listening on/.test(line.msg)), "the gateway to start");
    const started = lines().find((line) => /^listening on/.test(line.msg));
    assert.deepEqual([started.level, started.component], ["info", "gateway"]);
    assert.match(started.metrics, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${started.metrics}/metrics`)).status, 200);
    const url = started.msg.slice("listening on ".length);
    const response = await fetch(`${url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token({ task: "t7" }), "x-request-id": "trace-7" }, body: body() });
    await response.text();
    await until(() => lines().some((line) => line.request === "trace-7"), "the call's line");
    const call = lines().find((line) => line.request === "trace-7");
    const cost = costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 });
    assert.deepEqual(
      { ...call, ts: undefined, ms: undefined },
      { ts: undefined, level: "debug", component: "gateway", msg: "model call", request: "trace-7", tenant: "acme", task: "t7", upstream: "default", status: 200, ms: undefined, input: 10, output: 5, cost, upstream_request: "req_upstream_1" },
    );
    assert.ok(call.ms >= 0);
    // A call jig leaves partway through its stream: its line has what the tokens sent so far cost, as the metrics do.
    const client = new AbortController();
    const half = await fetch(`${url}/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token({ task: "t8" }), "x-request-id": "trace-8" }, body: body("half"), signal: client.signal });
    await half.body!.getReader().read();
    client.abort();
    await until(() => lines().some((line) => line.request === "trace-8"), "the left call's line");
    const left = lines().find((line) => line.request === "trace-8");
    assert.deepEqual([left.status, left.input, left.output, left.cost], [200, 10, 1, costOf(MODEL, { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 })]);
    // An error the gateway meets itself is logged with the request's id; fetch() can't send this target.
    await new Promise<void>((done, failed) => {
      const { hostname, port } = new URL(url);
      const socket = connect(Number(port), hostname, () => socket.end("GET http://[x/ HTTP/1.1\r\nhost: gateway\r\nx-request-id: bad-1\r\nconnection: close\r\n\r\n"));
      socket.on("data", () => {}).on("error", failed).on("close", () => done());
    });
    await until(() => lines().some((line) => line.request === "bad-1"), "the failed request's line");
    const failed = lines().find((line) => line.request === "bad-1");
    assert.deepEqual([failed.level, failed.msg, typeof failed.err?.message], ["error", "a request failed", "string"]);
    assert.ok(stderr.split("\n").filter(Boolean).every((line) => line.startsWith("{")), `only JSON lines: ${stderr}`);
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
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
    // The day's and the month's totals stay for billing; the bucket, full again a minute later, and the slot given back, go.
    assert.equal((await state.spentOn("acme", utcDay(now)))?.requests, 2);
    assert.equal((await state.spentIn("acme", utcDay(now).slice(0, 7)))?.requests, 2);
    assert.equal(state.size, 3);
    // A day goes after 35 days, a month after 400.
    state.prune(now + 36 * 86_400_000);
    assert.deepEqual([await state.spentOn("acme", utcDay(now)), (await state.spentIn("acme", utcDay(now).slice(0, 7)))?.requests], [undefined, 2]);
    state.prune(now + 401 * 86_400_000);
    assert.equal(state.size, 0);
  });

  it("keeps a tenant's day and month from its last reply, by the clock they are counted by", async () => {
    const DAY = 86_400_000;
    const start = Date.UTC(2026, 10, 1, 12);
    let time = start;
    const state = new MemoryState({ now: () => time });
    closing.push(() => state.close());
    const spend = () => state.spend({ tenant: "acme", task: "t", exp: Math.floor(Date.now() / 1000) + 3600, budgetUsd: null }, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, 0.01);
    await spend();
    time = start + 10 * DAY;
    await spend();
    time = start + 36 * DAY;
    state.prune();
    assert.deepEqual([await state.spentOn("acme", utcDay(start)), (await state.spentOn("acme", utcDay(start + 10 * DAY)))?.requests], [undefined, 1]);
    // The month is kept 400 days from its last reply, not its first.
    time = start + 405 * DAY;
    state.prune();
    assert.equal((await state.spentIn("acme", "2026-11"))?.requests, 2);
    time = start + 411 * DAY;
    state.prune();
    assert.equal(await state.spentIn("acme", "2026-11"), undefined);
  });

  it("forgets tasks and rate buckets by the wall clock, whatever clock the days are counted by", async () => {
    // A test's clock a month ahead: a task's token and a bucket's refill are in real time all the same.
    const state = new MemoryState({ now: () => Date.now() + 30 * 86_400_000 });
    closing.push(() => state.close());
    await state.spend({ tenant: "acme", task: "live", exp: Math.floor(Date.now() / 1000) + 3600, budgetUsd: null }, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, 0.01);
    const limits = { tenant: { requestsPerMinute: 1, burst: 1 }, global: {} };
    assert.equal(await state.admit("acme", "r1", limits), 0);
    await state.release("acme");
    state.prune();
    assert.equal((await state.spent("acme", "live"))?.requests, 1);
    assert.ok((await state.admit("acme", "r2", limits)) > 0, "the bucket is still empty");
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

  it("holds a tenant to its quota by this replica's own counts when 'open'", async () => {
    const provider = await fakeProvider();
    const redis = `redis://127.0.0.1:${await deadPort()}/1`;
    // The month's quota is the one spent, so both the day's and the month's own counts are read.
    const gw = await gateway(provider.url, { state: { redis, onStateError: "open" }, limits: { tenantDefaults: { dailyUsd: 1, monthlyUsd: 0.0001 } } });
    assert.deepEqual([await outcome(ask(gw, token())), await outcome(ask(gw, token()))], [[200, null], [200, null]]);
    const over = await ask(gw, token());
    assert.equal(over.status, 402);
    assert.match((await over.json()).error.message, /monthly quota/);
    assert.equal(provider.seen.length, 2);
    // Closed, a quota that can't be read refuses the request.
    const closed = await gateway(provider.url, { state: { redis }, limits: { tenantDefaults: { dailyUsd: 1 } } });
    assert.equal((await ask(closed, token())).status, 503);
  });

  it("says what is wrong with its state's config before it starts", async () => {
    await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "http://cache:6379" } }), /state.redis must be a Redis URL/);
    await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "redis://cache", onStateError: "maybe" as "open" } }), /onStateError/);
    // A lease of 0 or less would end as it is taken, which turns the concurrency limits off.
    for (const leaseMs of [0, -1, 1.5, "x"]) {
      await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "redis://cache", leaseMs: leaseMs as number } }), /state.leaseMs/, String(leaseMs));
    }
    await assert.rejects(gateway("http://127.0.0.1:9", { state: { redis: "redis://cache", prefix: 5 as unknown as string } }), /state.prefix/);
  });

  it("says Redis went away as a warning, and that it is back as news", async () => {
    let up = false;
    const redis = { leaseMs: 1000, spentOn: async () => (up ? undefined : Promise.reject(new Error("refused"))), close() {} } as unknown as RedisState;
    const said: [string, string][] = [];
    const state = new SharedState(redis, { onStateError: "open", onError: () => {}, log: (line, level) => said.push([level, line]) });
    closing.push(() => state.close());
    await state.spentOn("acme", "2026-11-05");
    up = true;
    await state.spentOn("acme", "2026-11-05");
    assert.deepEqual(said.map(([level, line]) => [level, line.split(";")[0]]), [["warn", "jig gateway: Redis can't be reached (refused)"], ["info", "jig gateway: Redis is back"]]);
  });

  it("lets go of its Redis when it can't listen, so a program that started it can end", async () => {
    // A stand-in Redis that keeps every connection it is given, and a port already taken.
    const open = new Set<Socket>();
    const accepted: Socket[] = [];
    const fake = createTcpServer((socket) => {
      accepted.push(socket);
      open.add(socket);
      socket.on("error", () => {}).on("close", () => open.delete(socket));
    });
    await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
    closing.push(() => (accepted.forEach((socket) => socket.destroy()), new Promise((done) => fake.close(done))));
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, "127.0.0.1", done));
    closing.push(() => new Promise((done) => taken.close(done)));
    const redis = `redis://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    await assert.rejects(gateway("http://127.0.0.1:9", { listen: { port: (taken.address() as AddressInfo).port }, state: { redis } }), /EADDRINUSE/);
    // Its subscriber may still be connecting: give it the time to, then every connection must go.
    await new Promise((done) => setTimeout(done, 200));
    const start = Date.now();
    await until(() => open.size === 0, "the gateway's connections to Redis to close");
    assert.ok(Date.now() - start < 1000, `closed within a second (${Date.now() - start} ms)`);
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

  it("holds all tenants together to the global concurrency across two gateways", async () => {
    const provider = await slowProvider(100);
    const state = { redis: REDIS!, prefix: prefix() };
    const limits = { maxWaitMs: 10_000, concurrent: 2 };
    const [a, b] = [await gateway(provider.url, { state, limits }), await gateway(provider.url, { state, limits })];
    // Each tenant's requests go through both gateways.
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => ask(i % 2 ? a : b, token({ tenant: i % 4 < 2 ? "acme" : "rival" }), `r${i}`)));
    assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));
    assert.equal(provider.most(), 2, "never more than 2 upstream at once, of both tenants, through both");
  });

  it("tells the other gateways at once when a slot is given back", async () => {
    // Two states on one prefix, with no Limiter to poll: only the message on the channel is heard.
    const shared = prefix();
    const [a, b] = [new RedisState(REDIS!, { prefix: shared }), new RedisState(REDIS!, { prefix: shared })];
    closing.push(() => (a.close(), b.close()));
    let heard = 0;
    a.onRelease(() => heard++);
    const start = Date.now();
    // Given back again until it is heard, as a's subscription may not be in place for the first.
    await until(async () => {
      await b.release("acme", "x");
      return heard > 0;
    }, "a to hear b give back a slot");
    assert.ok(Date.now() - start < 1000, `heard within a second (${Date.now() - start} ms)`);
  });

  it("counts a task's spending once for all gateways, and keeps it through a restart", async () => {
    // A write to Redis that takes a while, as on a busy one.
    const spend = RedisState.prototype.spend;
    RedisState.prototype.spend = async function (this: RedisState, ...args: Parameters<RedisState["spend"]>) {
      await new Promise((done) => setTimeout(done, 100));
      return spend.apply(this, args);
    };
    closing.push(() => (RedisState.prototype.spend = spend));
    const provider = await fakeProvider();
    const state = { redis: REDIS!, prefix: prefix() };
    const [a, b] = [await gateway(provider.url, { state }), await gateway(provider.url, { state })];
    // Each reply costs $0.00007: two, one through each, spend the task's $0.0001.
    const credential = token({ task: "capped", budgetUsd: 0.0001 });
    // Each reply read to its end, as jig reads it: a reply is counted by when it ends, not by its headers.
    const status = async (gw: Gateway, credential: string) => (await outcome(ask(gw, credential)))[0];
    assert.deepEqual([await status(a, credential), await status(b, credential), await status(a, credential)], [200, 200, 402]);
    const read = (gw: Gateway) => fetch(`${gw.url}/usage/capped`, { headers: { "x-api-key": credential } }).then((r) => r.json());
    assert.deepEqual([(await read(b)).requests, (await read(b)).usage.output, (await read(b)).upstreams], [2, 10, { default: 2 }]);
    await a.close();
    await b.close();
    const again = await gateway(provider.url, { state });
    assert.equal((await read(again)).requests, 2);
    assert.equal(await status(again, credential), 402);
    assert.equal(provider.seen.length, 2);
    // Another tenant's task of the same id is another task.
    assert.equal(await status(again, token({ tenant: "rival", task: "capped", budgetUsd: 0.0001 })), 200);
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
    // A gateway that has served nothing shows it resting too: its scrape reads the keys from Redis.
    const c = await gateway(provider.url, { state, upstream });
    assert.equal(await metric(c, 'jig_gateway_keys{upstream="default",state="resting"}'), 1);
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

  it("holds a tenant to its daily and monthly quotas across gateways, and reads its days back", async () => {
    const provider = await fakeProvider();
    const state = { redis: REDIS!, prefix: prefix() };
    // The last day of this month, at noon, then the first of the next: near enough to now that Redis keeps them.
    const today = new Date();
    const last = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0, 12);
    const time = clock(last - 24 * HOUR_MS);
    const config = { state, adminTokenEnv: "ADMIN_TOKEN", limits: { tenants: { daily: { dailyUsd: 0.0001 }, monthly: { monthlyUsd: 0.0002 } } } };
    const [a, b] = [await gateway(provider.url, config, { ADMIN_TOKEN: "admin-secret" }, time.now), await gateway(provider.url, config, { ADMIN_TOKEN: "admin-secret" }, time.now)];
    const as = (gw: Gateway, tenant: string) => ask(gw, token({ tenant }));
    // Each reply costs $0.00007: two, one through each, spend the day's $0.0001.
    assert.deepEqual([await outcome(as(a, "daily")), await outcome(as(b, "daily"))], [[200, null], [200, null]]);
    const over = await as(a, "daily");
    assert.deepEqual([over.status, (await over.json()).error.type, over.headers.get("retry-after")], [402, "billing_error", String(12 * 60 * 60)]);
    assert.equal(await metric(a, 'jig_gateway_refused_total{tenant="daily",reason="quota"}'), 1);
    assert.deepEqual(await outcome(as(b, "acme")), [200, null]);
    // The month's $0.0002, over two days and two gateways.
    assert.deepEqual(await outcome(as(a, "monthly")), [200, null]);
    time.set(last);
    assert.deepEqual([await outcome(as(b, "monthly")), await outcome(as(a, "monthly")), await outcome(as(b, "daily"))], [[200, null], [200, null], [200, null]]);
    const month = await as(a, "monthly");
    assert.deepEqual([month.status, month.headers.get("retry-after")], [402, String(12 * 60 * 60)]);
    assert.match((await month.json()).error.message, /monthly quota: \$0\.00021 of \$0\.0002 this month/);
    time.set(last + 12 * HOUR_MS);
    assert.deepEqual(await outcome(as(b, "monthly")), [200, null]);

    // The month's total is one hash, kept for 400 days; the days are read back through either gateway.
    const redis = new Redis(REDIS!);
    closing.push(() => redis.close());
    const monthKey = `${state.prefix}month:monthly:${utcDay(last).slice(0, 7)}`;
    assert.equal(await redis.command(["HGET", monthKey, "requests"]), "3");
    const ttl = Number(await redis.command(["TTL", monthKey]));
    assert.ok(ttl > 395 * 86_400 && ttl <= 400 * 86_400 + 31 * 86_400, `kept about 400 days: ${ttl} s`);
    const shared = new RedisState(REDIS!, { prefix: state.prefix });
    closing.push(() => shared.close());
    assert.equal((await shared.spentIn("daily", utcDay(last).slice(0, 7)))?.requests, 3);
    const from = utcDay(last - 24 * HOUR_MS), to = utcDay(last + 12 * HOUR_MS);
    const read = await (await fetch(`${b.url}/usage?tenant=monthly&from=${from}&to=${to}`, { headers: { authorization: "Bearer admin-secret" } })).json();
    assert.deepEqual(read.days.map((day: { day: string; requests: number }) => [day.day, day.requests]), [[from, 1], [utcDay(last), 2], [to, 1]]);
    assert.equal(read.total.requests, 4);
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
