import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkConfig, type Config, type Service, startService } from "../server/api.ts";
import { Webhooks } from "../server/approvals.ts";
import { createLog } from "../server/log.ts";
import type { Approval, Task } from "../server/store.ts";
import { mintToken } from "../server/token.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// Approvals over the API (docs/server.md): a task with approvals runs its jig with --approve-via, which
// asks at the service's internal listener and waits there for the tenant's answer through the API. The fake
// jig (fixtures/fake-jig.mjs) acts out jig's side of the approval contract. Each test runs on both stores:
// SQLite, and Postgres where JIG_TEST_POSTGRES_URL names one.

const FAKE_JIG = join(import.meta.dirname, "fixtures", "fake-jig.mjs");
const SECRET = "the gateway's secret";
const KEYS = { acme: "acme-key", globex: "globex-key" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const ACME = { id: "acme", keys: [sha256(KEYS.acme)] };
const GLOBEX = { id: "globex", keys: [sha256(KEYS.globex)] };

const services: Service[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const close of closers.splice(0)) await close();
  await removeTempDirs();
  await dropPostgresDatabases();
});

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;
let backend: (typeof BACKENDS)[number]["name"] = "SQLite";

async function database(base: string): Promise<string> {
  return backend === "SQLite" ? join(base, "jig.db") : postgresDatabase();
}

/** A service with the fake jig and both listeners on ports of their own; it keeps the task folders. */
async function service(config: Partial<Config> = {}, options: { webhookRetryMs?: number } = {}): Promise<Service & { dataDir: string }> {
  const base = await tempDir("jig-approvals-");
  const dataDir = join(base, "data");
  const started = await startService(
    {
      port: 0,
      internal: { port: 0 },
      database: config.database ?? (await database(base)),
      dataDir,
      keepTaskDirs: true,
      gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
      jig: [process.execPath, FAKE_JIG],
      graceSeconds: 5,
      tenants: [ACME, GLOBEX],
      ...config,
    },
    { secret: SECRET, ...options },
  );
  services.push(started);
  return { ...started, dataDir };
}

async function call(service: Service, key: string | undefined, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(service.url + path, {
    method,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** A GET of the internal listener, as a task's jig makes it. */
async function internal(service: Service, path: string, token?: string): Promise<{ status: number; body: any; ms: number }> {
  const started = Date.now();
  const res = await fetch(service.internalUrl + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  return { status: res.status, body: text && JSON.parse(text), ms: Date.now() - started };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const statusOf = (service: Service, id: string, status: string) =>
  until(async () => {
    const { body } = await call(service, KEYS.acme, "GET", `/v1/tasks/${id}`);
    return body.status === status && body;
  }, `task ${id} to be ${status}`);

const approvals = async (service: Service, id: string) => (await call(service, KEYS.acme, "GET", `/v1/tasks/${id}/approvals`)).body.approvals;
const asked = (service: Service, id: string, count: number) => until(async () => (await approvals(service, id)).length === count && approvals(service, id), `approval ${count}`);
const record = async (service: { dataDir: string }, id: string) => JSON.parse(await readFile(join(service.dataDir, "tasks", id, "work", ".fake-jig.json"), "utf8"));
/** A token for the task as the runner mints it. */
const tokenFor = (task: string, tenant = "acme", exp = Math.floor(Date.now() / 1000) + 600, secret = SECRET) => mintToken(secret, { tenant, task, exp, budgetUsd: null });

/** A task of acme's that stays queued (acme may run none), with approval ap_1 asked for, as a run would. */
async function queuedWithApproval(api: Service): Promise<string> {
  const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", approvals: true })).body.id;
  await api.store.addApproval(id, { id: "ap_1", step: 1, tool: "bash", description: "make deploy" });
  return id;
}

const approvalTests = () => {
  it("asks for approvals before a run's commands: the tenant answers through the API, and jig's long poll gets the answer", async () => {
    const api = await service({ tenants: [{ ...ACME, approvalTimeout: 120 }, GLOBEX] });
    const created = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 2", approvals: true, mode: "ask" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const [first] = await asked(api, id, 1);
    assert.deepEqual(first, { id: "ap_1", step: 2, tool: "bash", description: "rm -rf build/1", requestedAt: first.requestedAt });
    const task = (await call(api, KEYS.acme, "GET", `/v1/tasks/${id}`)).body;
    assert.deepEqual([task.status, task.approvals, task.mode, task.pendingApprovals], ["running", true, "ask", 1]);
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks")).body.tasks[0].pendingApprovals, 1);

    // Another tenant's task is as missing as ever; an approval not asked for is too; an answer is checked.
    assert.equal((await call(api, KEYS.globex, "GET", `/v1/tasks/${id}/approvals`)).status, 404);
    assert.equal((await call(api, KEYS.globex, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 404);
    assert.deepEqual(await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_9`, { decision: "allow" }), { status: 404, body: { error: "No such approval" } });
    for (const [body, error] of [[{ decision: "maybe" }, /decision must be allow or deny/], [{ decision: "allow", always: "yes" }, /always must be true or false/], [{ decision: "allow", by: "me" }, /Unknown field: by/], ["[", /isn't JSON/]] as const) {
      const refused = await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.match(refused.body.error, error);
    }

    const answered = await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow", always: true });
    assert.equal(answered.status, 200);
    assert.deepEqual(answered.body, { ...first, decision: "allow", always: true, by: "api", decidedAt: answered.body.decidedAt });
    const again = await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" });
    assert.equal(again.status, 409);
    assert.equal(again.body.approval.decision, "allow");
    await asked(api, id, 2);
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_2`, { decision: "deny" })).status, 200);

    const ended = await statusOf(api, id, "succeeded");
    assert.equal(ended.pendingApprovals, 0);
    const final = await approvals(api, id);
    assert.deepEqual(final.map(({ id, decision, always, by }: any) => [id, decision, always, by]), [["ap_1", "allow", true, "api"], ["ap_2", "deny", false, "api"]]);
    // jig's confirmation leaves the time the answer was given.
    assert.equal(final[0].decidedAt, answered.body.decidedAt);
    const types = (await api.store.events(id)).map(({ event }) => (event as { type: string }).type);
    assert.deepEqual(types.filter((type) => type.startsWith("approval")), ["approval_request", "approval", "approval_request", "approval"]);

    // jig asked at the internal listener, with the task's token, and got each answer by its long poll.
    const { args, polls } = await record(api, id);
    assert.deepEqual(args.slice(0, 6), ["--mode", "ask", "--approve-via", `${api.internalUrl}/internal/approvals`, "--approval-timeout", "120"]);
    assert.ok(!args.includes("--yes"));
    assert.equal(polls.filter((status: unknown) => status === 200).length, 2);
    assert.ok(polls.every((status: unknown) => status === 200 || status === 204), String(polls));
  });

  it("records jig's timeout as a deny, and takes no answer once the task has ended", async () => {
    const api = await service({ tenants: [{ ...ACME, approvalTimeout: 1 }, { ...GLOBEX, approvalTimeout: 120 }] });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    const task = await statusOf(api, id, "succeeded");
    assert.equal(task.mode, "edits");
    const [timedOut] = await approvals(api, id);
    assert.deepEqual([timedOut.decision, timedOut.always, timedOut.by, typeof timedOut.decidedAt], ["deny", false, "timeout", "string"]);
    assert.deepEqual((await record(api, id)).args.slice(0, 6), ["--mode", "edits", "--approve-via", `${api.internalUrl}/internal/approvals`, "--approval-timeout", "1"]);
    const late = await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" });
    assert.equal(late.status, 409);

    // A task cancelled while it waits has nothing pending, and its approval can't be answered.
    const waiting = (await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    await until(async () => (await call(api, KEYS.globex, "GET", `/v1/tasks/${waiting}`)).body.pendingApprovals === 1, "the approval");
    assert.equal((await call(api, KEYS.globex, "POST", `/v1/tasks/${waiting}/cancel`)).status, 202);
    const cancelled = await until(async () => {
      const { body } = await call(api, KEYS.globex, "GET", `/v1/tasks/${waiting}`);
      return body.status === "cancelled" && body;
    }, "the cancel");
    assert.equal(cancelled.pendingApprovals, 0);
    const refused = await call(api, KEYS.globex, "POST", `/v1/tasks/${waiting}/approvals/ap_1`, { decision: "allow" });
    assert.deepEqual([refused.status, refused.body.error], [409, "The task has already ended: cancelled"]);
  });

  it("answers on the internal listener only a task's own token, and wakes a long poll when the answer comes", async () => {
    const api = await service({ tenants: [{ ...ACME, concurrency: 0 }, GLOBEX] });
    const id = await queuedWithApproval(api);
    const token = tokenFor(id);
    assert.deepEqual((await internal(api, "/healthz")).body, { ok: true });
    assert.equal((await internal(api, "/v1/tasks", token)).status, 404, "the tenants' API isn't served there");
    for (const wrong of [undefined, KEYS.acme, tokenFor(id, "acme", 1000), tokenFor(id, "acme", undefined, "another secret")]) {
      assert.equal((await internal(api, "/internal/approvals/ap_1?wait=0", wrong)).status, 401);
    }
    assert.equal((await internal(api, "/internal/approvals/ap_1?wait=0", tokenFor("task_none"))).status, 404);
    assert.equal((await internal(api, "/internal/approvals/ap_1?wait=0", tokenFor(id, "globex"))).status, 404, "a token's task is its tenant's");
    assert.equal((await internal(api, "/internal/approvals/ap_1?wait=x", token)).status, 400);
    // Nor is the internal listener served on the tenants' one.
    assert.equal((await fetch(`${api.url}/internal/approvals/ap_1`, { headers: { authorization: `Bearer ${token}` } })).status, 401);

    const now = await internal(api, "/internal/approvals/ap_1?wait=0", token);
    assert.equal(now.status, 204);
    // An approval not asked for yet is waited for as one not answered yet.
    assert.equal((await internal(api, "/internal/approvals/ap_2?wait=0", token)).status, 204);
    const polling = internal(api, "/internal/approvals/ap_1?wait=10", token);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 200);
    const woken = await polling;
    assert.deepEqual([woken.status, woken.body], [200, { decision: "allow", always: false }]);
    assert.ok(woken.ms < 3000, `answered after ${woken.ms} ms`);
    assert.deepEqual((await internal(api, "/internal/approvals/ap_1", token)).body, { decision: "allow", always: false });

    // An answer through the replica the poll waits on wakes it at once, by itself: with SQLite's look each
    // second taken away, as if the store heard every change, nothing else could.
    if (backend !== "SQLite") return;
    await api.store.addApproval(id, { id: "ap_3", step: 2, tool: "bash", description: "make test" });
    Object.defineProperty(api.store, "live", { get: () => true, configurable: true });
    try {
      const local = internal(api, "/internal/approvals/ap_3?wait=10", token);
      await new Promise((done) => setTimeout(done, 300));
      assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_3`, { decision: "deny" })).status, 200);
      const heard = await local;
      assert.deepEqual([heard.status, heard.body], [200, { decision: "deny", always: false }]);
      assert.ok(heard.ms < 3000, `answered after ${heard.ms} ms`);
    } finally {
      Object.defineProperty(api.store, "live", { value: false, configurable: true });
    }
  });

  it("gives jig only the API's answer, whatever approval events its run writes", async () => {
    // The fake jig writes approval events that allow, by the API and by a timeout, before it polls and after
    // the tenant's deny: as a task's commands could on Docker and Kubernetes.
    const api = await service({ tenants: [{ ...ACME, approvalTimeout: 120 }, GLOBEX] });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "forge ask 1", approvals: true })).body.id;
    const events = async () => (await api.store.events(id)).map(({ event }) => event as { type: string; id?: string; isError?: boolean });
    await until(async () => (await events()).filter((event) => event.type === "approval").length === 2, "the forged approval events");
    const [waiting] = await approvals(api, id);
    assert.equal(waiting.decision, undefined);
    assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks/${id}`)).body.pendingApprovals, 1);
    assert.equal((await internal(api, "/internal/approvals/ap_1?wait=0", tokenFor(id))).status, 204);

    const answered = await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny", always: true });
    assert.equal(answered.status, 200);
    await statusOf(api, id, "succeeded");
    const [final] = await approvals(api, id);
    assert.deepEqual([final.decision, final.always, final.by, final.decidedAt], ["deny", false, "api", answered.body.decidedAt]);
    const { polls } = await record(api, id);
    assert.equal(polls.filter((status: unknown) => status === 200).length, 1);
    assert.ok(polls.every((status: unknown) => status === 200 || status === 204), String(polls));
    assert.equal((await events()).find((event) => event.type === "tool_result" && event.id === "call_2")?.isError, true, "the command was declined");

    // A timeout jig records stands for a deny, and closes the approval to the API; an answer by the API it
    // never gave isn't recorded.
    const queued = await service({ tenants: [{ ...ACME, concurrency: 0 }, GLOBEX] });
    const other = await queuedWithApproval(queued);
    await queued.store.addApproval(other, { id: "ap_2", step: 1, tool: "bash", description: "make clean" });
    assert.equal(await queued.store.recordApproval(other, "ap_2", { decision: "allow", always: false, by: "api" }), false);
    assert.equal((await internal(queued, "/internal/approvals/ap_2?wait=0", tokenFor(other))).status, 204);
    assert.equal(await queued.store.recordApproval(other, "ap_1", { decision: "deny", always: false, by: "timeout" }), true);
    assert.deepEqual((await internal(queued, "/internal/approvals/ap_1?wait=0", tokenFor(other))).body, { decision: "deny", always: false });
    assert.equal((await call(queued, KEYS.acme, "POST", `/v1/tasks/${other}/approvals/ap_1`, { decision: "allow" })).status, 409);
  });

  it("wakes a long poll on one replica when the answer is posted through another", async () => {
    const base = await tempDir("jig-approvals-");
    const db = await database(base);
    const tenants = [{ ...ACME, concurrency: 0 }, GLOBEX];
    const [first, second] = [await service({ database: db, tenants }), await service({ database: db, tenants })];
    const id = await queuedWithApproval(first);
    const polling = internal(second, "/internal/approvals/ap_1?wait=10", tokenFor(id));
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await call(first, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" })).status, 200);
    const woken = await polling;
    assert.deepEqual([woken.status, woken.body], [200, { decision: "deny", always: false }]);
    // Announced on Postgres; on SQLite, found by the look each second.
    assert.ok(woken.ms < 3000, `answered after ${woken.ms} ms`);
  });

  it("takes an answer posted the moment its approval_request event is streamed, through another replica", async () => {
    // The approval is stored before its event, so a tenant that answers as soon as it sees the event is
    // never told there is no such approval.
    const base = await tempDir("jig-approvals-");
    const db = await database(base);
    const tenants = [{ ...ACME, approvalTimeout: 120 }, GLOBEX];
    const [first, second] = [await service({ database: db, tenants }), await service({ database: db, tenants })];
    const id = (await call(first, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    const stream = await fetch(`${second.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${KEYS.acme}` } });
    const decoder = new TextDecoder();
    let text = "";
    let answered: { status: number; body: any } | undefined;
    for await (const chunk of stream.body!) {
      text += decoder.decode(chunk, { stream: true });
      if (answered || !text.includes('"type":"approval_request"')) continue;
      answered = await call(second, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" });
      // Unanswered, the run would wait out its 120 seconds.
      if (answered.status !== 200) break;
    }
    assert.equal(answered?.status, 200, JSON.stringify(answered?.body));
    assert.match(text, /event: done\ndata: \{"status":"succeeded"\}/);
  });

  it("posts each approval to the tenant's webhook, signed, tried again, and never holds the run up", async () => {
    // The first POST hangs until the test lets it go, with a 500; the next fails too; the third is taken.
    const posts: { headers: IncomingHttpHeaders; body: string; at: number }[] = [];
    let release!: () => void;
    const receiver = createServer((req, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        posts.push({ headers: req.headers, body, at: Date.now() });
        if (posts.length === 1) release = () => void res.writeHead(500).end();
        else res.writeHead(posts.length === 2 ? 500 : 204).end();
      });
    });
    await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => (receiver.closeAllConnections(), receiver.close(done))));
    const saved = process.env.ACME_WEBHOOK_SECRET;
    process.env.ACME_WEBHOOK_SECRET = "acme's webhook secret";
    closers.push(async () => (saved === undefined ? delete process.env.ACME_WEBHOOK_SECRET : (process.env.ACME_WEBHOOK_SECRET = saved)));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/approvals`;
    const api = await service({ tenants: [{ ...ACME, approvalTimeout: 120, approvalWebhook: url, webhookSecretEnv: "ACME_WEBHOOK_SECRET" }, GLOBEX] }, { webhookRetryMs: 50 });

    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    const [approval] = await asked(api, id, 1);
    await until(() => posts.length === 1, "the webhook's POST");
    // Answered, and the run done, while the webhook's first POST still hangs.
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 200);
    await statusOf(api, id, "succeeded");
    assert.equal(posts.length, 1);
    release();
    await until(() => posts.length === 3, "the webhook's retries");
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(posts.length, 3, "no more once one is taken");
    for (const post of posts) {
      assert.deepEqual(JSON.parse(post.body), { task: id, approval });
      assert.equal(post.headers["content-type"], "application/json");
      assert.equal(post.headers["x-jig-signature"], `sha256=${createHmac("sha256", "acme's webhook secret").update(post.body).digest("hex")}`);
    }
    assert.ok(posts[2].at - posts[1].at >= 90, "the second retry waits twice as long as the first");
  });

  it("checks a task's approvals and mode, and runs one without approvals with --yes", async () => {
    const api = await service();
    for (const [body, error] of [
      [{ prompt: "hi", approvals: "yes" }, "approvals must be true or false"],
      [{ prompt: "hi", mode: "ask" }, "mode goes with approvals: true"],
      [{ prompt: "hi", approvals: false, mode: "edits" }, "mode goes with approvals: true"],
      [{ prompt: "hi", approvals: true, mode: "auto" }, "mode must be one of: plan, ask, edits"],
    ] as const) {
      assert.deepEqual(await call(api, KEYS.acme, "POST", "/v1/tasks", body), { status: 400, body: { error } });
    }
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", approvals: false })).body.id;
    const task = await statusOf(api, id, "succeeded");
    assert.deepEqual([task.approvals, "mode" in task, task.pendingApprovals], [false, false, 0]);
    assert.equal((await record(api, id)).args[0], "--yes");
    assert.deepEqual(await approvals(api, id), []);
  });
};

for (const { name, skip } of BACKENDS) {
  describe(`approvals through the task service (${name})`, { skip }, () => {
    beforeEach(() => void (backend = name));
    approvalTests();
  });
}

describe("the approvals' webhooks", () => {
  it("posts no webhook once the webhooks are closed, as the service stops", async () => {
    // Runs still draining as the service stops may store an approval after the webhooks are closed: its
    // POST, retried for up to a minute, would hold up whoever embeds the service.
    const posts: string[] = [];
    const receiver = createServer((req, res) => {
      posts.push(req.url ?? "");
      res.writeHead(204).end();
    });
    await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => (receiver.closeAllConnections(), receiver.close(done))));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/approvals`;
    const webhooks = new Webhooks(new Map([["acme", { url, secret: "acme's webhook secret" }]]), 50);
    const task = { id: "task_1", tenant: "acme" } as Task;
    const approval: Approval = { id: "ap_1", step: 1, tool: "bash", description: "make deploy", requestedAt: new Date().toISOString() };
    webhooks.send(task, approval);
    await until(() => posts.length === 1, "the webhook's POST");
    webhooks.close();
    webhooks.send(task, approval);
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(posts.length, 1);
  });

  it("follows no redirect: a 3xx is a failed try, and the signed body goes nowhere else", async () => {
    // A tenant's endpoint could otherwise send the service's POST on to anything it can reach.
    const elsewhere: string[] = [];
    const inner = createServer((req, res) => {
      elsewhere.push(req.url ?? "");
      res.writeHead(204).end();
    });
    await new Promise<void>((done) => inner.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => (inner.closeAllConnections(), inner.close(done))));
    let tries = 0;
    const outer = createServer((_req, res) => {
      tries++;
      res.writeHead(307, { location: `http://127.0.0.1:${(inner.address() as AddressInfo).port}/admin/do-something` }).end();
    });
    await new Promise<void>((done) => outer.listen(0, "127.0.0.1", done));
    closers.push(() => new Promise((done) => (outer.closeAllConnections(), outer.close(done))));
    const lines: string[] = [];
    const log = createLog("service", { format: "text", level: "info", write: (line) => lines.push(line) });
    const webhooks = new Webhooks(new Map([["acme", { url: `http://127.0.0.1:${(outer.address() as AddressInfo).port}/hooks/approvals`, secret: "s" }]]), 10, log);
    closers.push(async () => webhooks.close());
    const approval: Approval = { id: "ap_1", step: 1, tool: "bash", description: "make deploy", requestedAt: new Date().toISOString() };
    webhooks.send({ id: "task_1", tenant: "acme" } as Task, approval);
    const warned = await until(() => lines.find((line) => line.includes("approval webhook failed")), "the warning");
    assert.match(warned, /4 times: 307 \(redirects are not followed\)/);
    assert.deepEqual([tries, elsewhere], [4, []]);
  });

  it("says a 3xx that isn't a redirect (a 304, say) failed with its status alone", async () => {
    for (const [status, said] of [
      [300, "300"],
      [304, "304"],
      [308, "308 (redirects are not followed)"],
    ] as const) {
      const receiver = createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(status, { location: "http://127.0.0.1:1/elsewhere" }).end());
      });
      await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
      closers.push(() => new Promise((done) => (receiver.closeAllConnections(), receiver.close(done))));
      const lines: string[] = [];
      const log = createLog("service", { format: "text", level: "info", write: (line) => lines.push(line) });
      const webhooks = new Webhooks(new Map([["acme", { url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/approvals`, secret: "s" }]]), 5, log);
      closers.push(async () => webhooks.close());
      webhooks.send({ id: "task_1", tenant: "acme" } as Task, { id: "ap_1", step: 1, tool: "bash", description: "make deploy", requestedAt: new Date().toISOString() });
      const warned = await until(() => lines.find((line) => line.includes("approval webhook failed")), `the warning for a ${status}`);
      assert.ok(warned.includes(`4 times: ${said}`), warned);
      if (!said.includes("redirect")) assert.ok(!warned.includes("redirect"), warned);
    }
  });

  it("counts deliveries by tenant: delivered, or failed once the last try fails", async () => {
    // acme's endpoint always answers 503; globex's twice, then takes it.
    const receiver = (status: (n: number) => number) => {
      let n = 0;
      return createServer((req, res) => {
        req.resume();
        req.on("end", () => res.writeHead(status(++n)).end());
      });
    };
    const urls: string[] = [];
    for (const server of [receiver(() => 503), receiver((n) => (n <= 2 ? 503 : 200))]) {
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      closers.push(() => new Promise((done) => (server.closeAllConnections(), server.close(done))));
      urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/approvals`);
    }
    const saved = process.env.JIG_TEST_WEBHOOK_SECRET;
    process.env.JIG_TEST_WEBHOOK_SECRET = "a webhook secret";
    closers.push(async () => (saved === undefined ? delete process.env.JIG_TEST_WEBHOOK_SECRET : (process.env.JIG_TEST_WEBHOOK_SECRET = saved)));
    const hook = (url: string) => ({ approvalTimeout: 120, approvalWebhook: url, webhookSecretEnv: "JIG_TEST_WEBHOOK_SECRET" });
    const api = await service({ metrics: { port: 0 }, tenants: [{ ...ACME, ...hook(urls[0]) }, { ...GLOBEX, ...hook(urls[1]) }] }, { webhookRetryMs: 10 });
    const counted = async () => (await (await fetch(`${api.metricsUrl}/metrics`)).text()).split("\n").filter((line) => line.startsWith("jig_service_webhook_deliveries_total")).sort();
    // acme's delivered and failed, then globex's.
    const series = (...values: number[]) =>
      ["acme delivered", "acme failed", "globex delivered", "globex failed"].map((labels, i) => {
        const [tenant, result] = labels.split(" ");
        return `jig_service_webhook_deliveries_total{tenant="${tenant}",result="${result}"} ${values[i]}`;
      });
    // Each tenant with a webhook starts at 0 both ways, so increase() sees its first failures.
    assert.deepEqual(await counted(), series(0, 0, 0, 0));
    for (const [tenant, key] of Object.entries(KEYS)) {
      const id = (await call(api, key, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
      await until(async () => (await call(api, key, "GET", `/v1/tasks/${id}/approvals`)).body.approvals.length === 1, `${tenant}'s approval`);
      assert.equal((await call(api, key, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 200);
    }
    await until(async () => (await counted()).filter((line) => line.endsWith(" 1")).length === 2, "both tenants' deliveries counted");
    assert.deepEqual(await counted(), series(0, 1, 1, 0));
  });
});

describe("the approvals' config", () => {
  const base = { database: ":memory:", dataDir: "data", gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [] } satisfies Config;
  const problem = (config: object) => {
    try {
      checkConfig({ ...base, ...config } as Config);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("is refused with what is wrong", async () => {
    assert.equal(problem({ internal: { host: "0.0.0.0", port: 8082 }, internalBaseUrl: "http://api:8082" }), undefined);
    assert.equal(problem({ internal: 8082 }), "The config's internal must be an object, {host, port}");
    assert.equal(problem({ internal: { port: 70000 } }), "The config's internal.port must be a whole number from 0 to 65535, not 70000");
    assert.equal(problem({ internalBaseUrl: "api:8082" }), 'The config\'s internalBaseUrl must be an http or https URL, not "api:8082"');
    assert.equal(problem({ tenants: [{ ...ACME, approvalTimeout: 0 }] }), "The config's tenants[0].approvalTimeout must be a whole number from 1 to 2000000, not 0");
    assert.equal(problem({ tenants: [{ ...ACME, approvalWebhook: "https://hooks.example.com/jig" }] }), "The config's tenants[0].webhookSecretEnv is missing");
    assert.equal(problem({ tenants: [{ ...ACME, approvalWebhook: "hooks", webhookSecretEnv: "X" }] }), 'The config\'s tenants[0].approvalWebhook must be an http or https URL, not "hooks"');
    const unset = "JIG_TEST_A_VARIABLE_NOT_SET";
    await assert.rejects(
      startService({ ...base, internal: { port: 0 }, tenants: [{ ...ACME, approvalWebhook: "https://hooks.example.com/jig", webhookSecretEnv: unset }] }, { secret: SECRET }),
      new RegExp(`Set ${unset}, the secret tenant acme's approval webhook is signed with`),
    );
  });
});
