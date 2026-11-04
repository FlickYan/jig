import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { type Service, startService } from "../server/api.ts";
import { type Gateway, startGateway } from "../server/gateway.ts";
import { Redis } from "../server/redis.ts";
import { mintToken } from "../server/token.ts";
import { costOf } from "../src/prices.ts";
import { type Block, messagesReply } from "./fake-api.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The whole of Phase 1 at once, with nothing faked but the provider: a task posted to the task service's API
// is scheduled, run by the local runner as the real jig (src/cli.ts) with --events, whose model calls go
// through the gateway with the task's token, to a stand-in for the Messages API that sees only the real key.
// Then Phase 2's approvals the same way: the real jig's --approve-via, answered through the API, with the
// task service's state in SQLite or Postgres and the gateway's in memory or Redis.

const SECRET = "the secret the service and the gateway share";
const PROVIDER_KEY = "sk-the-provider-key";
const TENANT_KEY = "acme-key";
const MODEL = "claude-opus-5-5";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await removeTempDirs();
  await dropPostgresDatabases();
});

interface Seen {
  headers: IncomingHttpHeaders;
  body: { messages: { role: string; content: unknown }[] };
}

/** The provider: answers the n-th request with the n-th reply (the last one again after them). */
async function provider(replies: Block[][]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      if (req.headers["x-api-key"] !== PROVIDER_KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesReply(replies[Math.min(seen.length, replies.length) - 1]!));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const REDIS = process.env.JIG_TEST_REDIS_URL;

/** Where the service and the gateway keep their state: SQLite and memory, or Postgres and Redis. */
interface Backends {
  postgres?: boolean;
  redis?: boolean;
}

/** A Redis prefix of the test's own, its keys deleted after (once the gateway is closed). */
function redisPrefix(): string {
  const prefix = `jig:e2e:${randomUUID()}:`;
  closers.unshift(async () => {
    const redis = new Redis(REDIS!);
    const keys = (await redis.command(["KEYS", `${prefix}*`])) as string[];
    if (keys.length) await redis.command(["DEL", ...keys]);
    redis.close();
  });
  return prefix;
}

async function stack(replies: Block[][], backends: Backends = {}): Promise<{ service: Service; gateway: Gateway; seen: Seen[]; dataDir: string }> {
  const upstream = await provider(replies);
  const gateway = await startGateway(
    { listen: { port: 0 }, upstream: { baseUrl: upstream.url, keyEnv: ["PROVIDER_KEY"] }, ...(backends.redis && { state: { redis: REDIS!, prefix: redisPrefix() } }) },
    { JIG_GATEWAY_SECRET: SECRET, PROVIDER_KEY },
  );
  closers.push(() => gateway.close());
  const base = await tempDir("jig-e2e-");
  const dataDir = join(base, "data");
  const service = await startService(
    {
      port: 0,
      internal: { port: 0 },
      database: backends.postgres ? await postgresDatabase() : join(base, "jig.db"),
      dataDir,
      model: MODEL,
      gatewayBaseUrl: `${gateway.url}/anthropic`,
      graceSeconds: 5,
      // The test reads what jig printed in the task's folder.
      keepTaskDirs: true,
      tenants: [{ id: "acme", keys: [sha256(TENANT_KEY)], budgetUsd: 1 }],
    },
    { secret: SECRET },
  );
  closers.push(() => service.close());
  return { service, gateway, seen: upstream.seen, dataDir };
}

async function call(service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(service.url + path, {
    method,
    headers: { authorization: `Bearer ${TENANT_KEY}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 50))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ended = (service: Service, id: string) =>
  until(async () => {
    const { body } = await call(service, "GET", `/v1/tasks/${id}`);
    return !["queued", "running"].includes(body.status) && body;
  }, `task ${id} to end`);

/** The task's events as the API streams them, to the end. */
async function events(service: Service, id: string): Promise<{ id: string; event?: string; data: any }[]> {
  const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` } });
  const frames = (await res.text()).split("\n\n").filter((frame) => /^data:/m.test(frame));
  return frames.map((frame) => {
    const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, "m").exec(frame)?.[1];
    const data = field("data")!;
    return { id: field("id")!, event: field("event"), data: field("event") === "done" ? data : JSON.parse(data) };
  });
}

describe("Phase 1 end to end: API, scheduler, local runner, jig --events, gateway", () => {
  it("runs a task with the real jig through the gateway, and its events, usage and cost agree everywhere", async () => {
    const { service, gateway, seen, dataDir } = await stack([[{ tool: "bash", input: { command: "cat note.txt" } }], [{ text: "The note says hello." }]]);
    const posted = await call(service, "POST", "/v1/tasks", { prompt: "what does note.txt say?", workspace: { files: { "note.txt": "hello\n" } }, maxSteps: 5 });
    assert.equal(posted.status, 201);
    const task = await ended(service, posted.body.id);

    assert.equal(task.status, "succeeded", JSON.stringify(task));
    assert.equal(task.stop, "end_turn");
    // The provider saw the real key, never the task's token, and the command's output came back to it.
    assert.equal(seen.length, 2);
    for (const request of seen) {
      assert.equal(request.headers["x-api-key"], PROVIDER_KEY);
      assert.doesNotMatch(JSON.stringify(request.headers), /jgt1\./);
    }
    assert.match(JSON.stringify(seen[1]!.body.messages.at(-1)), /hello/);

    const stream = await events(service, task.id);
    const types = stream.filter((frame) => !frame.event).map((frame) => frame.data.type);
    assert.deepEqual(types, ["start", "step", "tool_call", "tool_result", "step", "text", "end"]);
    assert.deepEqual(stream.map((frame) => Number(frame.id)).filter(Boolean), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(stream.at(-1)!.event, "done");
    const end = stream.find((frame) => frame.data.type === "end")!.data;
    assert.equal(end.exitCode, 0);
    assert.match(stream.find((frame) => frame.data.type === "tool_result")!.data.output, /^hello\n[^]*Exit code: 0/);

    // Two calls of 10 input and 5 output tokens each, priced the same by jig, the service and the gateway.
    const usage = { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 };
    assert.deepEqual(end.usage, usage);
    assert.deepEqual(task.usage, usage);
    const cost = costOf(MODEL, usage)!;
    assert.ok(Math.abs(task.cost - cost) < 1e-9);
    assert.doesNotMatch(await readFile(join(dataDir, "tasks", task.id, "output.log"), "utf8"), /jgt1\./, "jig printed its token");
    const taskToken = mintToken(SECRET, { tenant: "acme", task: task.id, exp: Math.floor(Date.now() / 1000) + 600, budgetUsd: 1 });
    const spent = await fetch(`${gateway.url}/usage/${task.id}`, { headers: { authorization: `Bearer ${taskToken}` } });
    assert.equal(spent.status, 200);
    const gw = await spent.json();
    assert.equal(gw.tenant, "acme");
    assert.equal(gw.requests, 2);
    assert.ok(Math.abs(gw.costUsd - cost) < 1e-9);
    assert.equal(gw.budgetUsd, 1);
  });

  it("cancels a running task: the real jig and its command are stopped, and the task ends cancelled", async () => {
    const { service } = await stack([[{ tool: "bash", input: { command: "sleep 60" } }], [{ text: "done" }]]);
    const { body } = await call(service, "POST", "/v1/tasks", { prompt: "wait a minute", maxSteps: 5 });
    await firstOf(service, body.id, "tool_call");
    const cancelled = await call(service, "POST", `/v1/tasks/${body.id}/cancel`);
    assert.ok([200, 202].includes(cancelled.status));
    const started = Date.now();
    const task = await ended(service, body.id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.stop, "interrupted");
    assert.ok(Date.now() - started < 15_000, "the cancel took too long");
  });
});

/** Follows the task's event stream until an event of this type comes, then lets go of it. */
async function firstOf(service: Service, id: string, type: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` }, signal: abort.signal });
    let text = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += Buffer.from(chunk).toString("utf8");
      if (text.includes(`"type":"${type}"`)) return;
    }
    throw new Error(`the task ended with no ${type} event`);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

for (const { name, backends, skip } of [
  { name: "SQLite and memory", backends: {}, skip: false },
  { name: "Postgres and Redis", backends: { postgres: true, redis: true }, skip: NO_POSTGRES || (!REDIS && "JIG_TEST_REDIS_URL isn't set") },
]) {
  describe(`Phase 2 end to end, the state in ${name}: the real jig asks through the API before a command`, { skip }, () => {
    /** Posts a task that asks before its command, and waits until the approval waits for an answer. */
    async function asking(service: Service): Promise<{ id: string; approval: any }> {
      const posted = await call(service, "POST", "/v1/tasks", { prompt: "write the file", approvals: true, mode: "ask", maxSteps: 5 });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      const { id } = posted.body;
      await until(async () => (await call(service, "GET", `/v1/tasks/${id}`)).body.pendingApprovals === 1, "the approval to wait");
      const listed = await call(service, "GET", `/v1/tasks/${id}/approvals`);
      assert.equal(listed.body.approvals.length, 1);
      return { id, approval: listed.body.approvals[0] };
    }

    it("runs the command once the API allows it, and the record says the API answered", async () => {
      const { service, seen } = await stack([[{ tool: "bash", input: { command: "echo allowed > out.txt && cat out.txt" } }], [{ text: "Written." }]], backends);
      const { id, approval } = await asking(service);
      assert.equal(approval.id, "ap_1");
      assert.equal(approval.tool, "bash");
      assert.match(approval.description, /echo allowed/);
      assert.equal(approval.decision, undefined);

      const answered = await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" })).status, 409);
      const task = await ended(service, id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.equal(task.pendingApprovals, 0);

      const stream = await events(service, id);
      const types = stream.filter((frame) => !frame.event).map((frame) => frame.data.type);
      assert.deepEqual(types, ["start", "step", "tool_call", "approval_request", "approval", "tool_result", "step", "text", "end"]);
      const { id: approvalId, decision, by } = stream.find((frame) => frame.data.type === "approval")!.data;
      assert.deepEqual({ approvalId, decision, by }, { approvalId: "ap_1", decision: "allow", by: "api" });
      assert.match(stream.find((frame) => frame.data.type === "tool_result")!.data.output, /^allowed\n/);
      assert.match(JSON.stringify(seen[1]!.body.messages.at(-1)), /allowed/);
      const record = (await call(service, "GET", `/v1/tasks/${id}/approvals`)).body.approvals[0];
      assert.equal(record.decision, "allow");
      assert.equal(record.by, "api");
    });

    it("doesn't run the command the API denies, and the model hears it was denied", async () => {
      const { service, seen } = await stack([[{ tool: "bash", input: { command: "echo nope > out.txt" } }], [{ text: "I won't, then." }]], backends);
      const { id } = await asking(service);
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" })).status, 200);
      const task = await ended(service, id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      const stream = await events(service, id);
      assert.equal(stream.find((frame) => frame.data.type === "approval")!.data.decision, "deny");
      assert.equal(seen.length, 2);
      const told = JSON.stringify(seen[1]!.body.messages.at(-1));
      assert.doesNotMatch(told, /Exit code/);
      assert.match(told, /den|declin|not allowed|refus/i);
    });

    it("cancels a task while its approval waits, and the approval waits no more", async () => {
      const { service } = await stack([[{ tool: "bash", input: { command: "echo never > never.txt" } }], [{ text: "done" }]], backends);
      const { id } = await asking(service);
      const started = Date.now();
      assert.ok([200, 202].includes((await call(service, "POST", `/v1/tasks/${id}/cancel`)).status));
      const task = await ended(service, id);
      assert.equal(task.status, "cancelled");
      assert.equal(task.pendingApprovals, 0);
      assert.ok(Date.now() - started < 15_000, "the cancel took too long");
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 409);
    });
  });
}
