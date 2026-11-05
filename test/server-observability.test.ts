import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkConfig, type Config, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import type { Runner } from "../server/runner.ts";
import { DockerRunner } from "../server/runners/docker.ts";
import { ROUTES, routeOf, serviceMetrics } from "../server/service-metrics.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";
import { parseYaml } from "./yaml.ts";

// What the task service tells an operator (docs/server.md, Metrics and logs): its metrics, on a listener of
// their own, its logs, as text or JSON lines with the request, tenant and task they are about, and the
// x-request-id of every response; and the Prometheus, alert and Grafana files in deploy/observability.
// The fake jig and the fake docker CLI stand in for jig and docker.

const FIXTURES = join(import.meta.dirname, "fixtures");
const FAKE_JIG = join(FIXTURES, "fake-jig.mjs");
const FAKE_DOCKER = join(FIXTURES, "fake-docker.mjs");
const DEPLOY = join(import.meta.dirname, "..", "deploy");
const SECRET = "the gateway's secret";
const KEYS = { acme: "acme-key", globex: "globex-key", initech: "initech-key" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const services: Service[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await removeTempDirs();
  await dropPostgresDatabases();
});

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;
let backend: (typeof BACKENDS)[number]["name"] = "SQLite";

/** A new database of the backend's: a file in `base`, or a schema in the test Postgres. */
async function database(base: string): Promise<string> {
  return backend === "SQLite" ? join(base, "jig.db") : postgresDatabase();
}

/**
 * A service with the fake jig, its metrics on a listener of their own, read fresh at each scrape, and its
 * log's JSON lines, at debug, in `lines`.
 */
async function service(config: Partial<Config> = {}, runner?: Runner, options: { webhookRetryMs?: number } = {}): Promise<Service & { dataDir: string; lines: any[] }> {
  const base = await tempDir("jig-observe-");
  const dataDir = join(base, "data");
  const lines: any[] = [];
  const log = createLog("service", { format: "json", level: "debug", write: (line) => lines.push(JSON.parse(line)) });
  const started = await startService(
    {
      port: 0,
      internal: { port: 0 },
      metrics: { port: 0 },
      database: config.database ?? (await database(base)),
      dataDir,
      keepTaskDirs: true,
      gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
      jig: [process.execPath, FAKE_JIG],
      graceSeconds: 5,
      tenants: [
        { id: "acme", keys: [sha256(KEYS.acme)], concurrency: 1 },
        { id: "globex", keys: [sha256(KEYS.globex)] },
      ],
      ...config,
    },
    { secret: SECRET, runner, log, countsMs: 0, ...options },
  );
  services.push(started);
  return { ...started, dataDir, lines };
}

async function call(service: Service, key: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(service.url + path, {
    method,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ended = (service: Service, key: string, id: string) =>
  until(async () => {
    const { body } = await call(service, key, "GET", `/v1/tasks/${id}`);
    return body.ended && body;
  }, `task ${id} to end`);

/** The metrics as Prometheus reads them: each series (its name and labels, as written) and its value; and the text. */
async function scrape(service: Service): Promise<{ text: string; value: (series: string) => number | undefined }> {
  const res = await fetch(`${service.metricsUrl}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type")!, /^text\/plain; version=0\.0\.4/);
  const text = await res.text();
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const at = line.lastIndexOf(" ");
    values.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return { text, value: (series) => values.get(series) };
}

const observeTests = () => {
  it("counts tasks from created to ended, by tenant and status, with the queue read from the store at each scrape", async () => {
    const api = await service({
      tenants: [
        // acme runs one at a time; globex runs none, and may create one a day; initech may queue none.
        { id: "acme", keys: [sha256(KEYS.acme)], concurrency: 1 },
        { id: "globex", keys: [sha256(KEYS.globex)], concurrency: 0, quotas: { tasksPerDay: 1 } },
        { id: "initech", keys: [sha256(KEYS.initech)], maxQueued: 0 },
      ],
    });
    const first = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "wait" })).body.id;
    const second = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 2" })).body.id;
    const held = (await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    assert.equal((await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 429);
    assert.equal((await call(api, KEYS.initech, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 429);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "" })).status, 400);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", "{")).status, 400);
    await until(async () => (await call(api, KEYS.acme, "GET", `/v1/tasks/${first}`)).body.status === "running", "the first to run");

    // Queued and running, from the store: the config's tenants with none show 0.
    let { value } = await scrape(api);
    assert.equal(value('jig_service_tasks{tenant="acme",status="running"}'), 1);
    assert.equal(value('jig_service_tasks{tenant="acme",status="queued"}'), 1);
    assert.equal(value('jig_service_tasks{tenant="globex",status="queued"}'), 1);
    assert.equal(value('jig_service_tasks{tenant="initech",status="queued"}'), 0);
    assert.ok(value('jig_service_queue_oldest_seconds{tenant="globex"}')! >= 0);
    assert.equal(value('jig_service_queue_oldest_seconds{tenant="initech"}'), undefined);
    assert.equal(value('jig_service_tasks_created_total{tenant="acme"}'), 2);
    assert.equal(value('jig_service_tasks_created_total{tenant="globex"}'), 1);
    assert.equal(value('jig_service_tasks_refused_total{tenant="globex",reason="quota"}'), 1);
    assert.equal(value('jig_service_tasks_refused_total{tenant="initech",reason="queue"}'), 1);
    assert.equal(value('jig_service_tasks_refused_total{tenant="acme",reason="invalid"}'), 2);
    assert.equal(value("jig_service_replicas"), 1);
    assert.equal(value("jig_service_approvals_pending"), 0);
    assert.equal(value("jig_service_pool_idle"), undefined, "no pool");

    // The first lets the second run; both end, and are counted with what they spent and how long they took.
    await writeFile(join(api.dataDir, "tasks", first, "work", "go"), "");
    await ended(api, KEYS.acme, second);
    const stream = await fetch(`${api.url}/v1/tasks/${first}/events`, { headers: { authorization: `Bearer ${KEYS.acme}` } });
    assert.match(await stream.text(), /event: done/);
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${held}/cancel`)).status, 404);
    assert.equal((await call(api, KEYS.globex, "POST", `/v1/tasks/${held}/cancel`)).status, 200);
    let text: string;
    ({ value, text } = await scrape(api));
    assert.equal(value('jig_service_tasks_ended_total{tenant="acme",status="succeeded"}'), 1);
    assert.equal(value('jig_service_tasks_ended_total{tenant="acme",status="stopped"}'), 1);
    assert.equal(value('jig_service_tasks_ended_total{tenant="globex",status="cancelled"}'), 1);
    assert.equal(value('jig_service_tasks{tenant="acme",status="running"}'), 0);
    assert.equal(value('jig_service_tasks{tenant="globex",status="queued"}'), 0);
    assert.equal(value('jig_service_queue_oldest_seconds{tenant="globex"}'), undefined);
    assert.equal(value("jig_service_queue_seconds_count"), 2);
    assert.equal(value('jig_service_run_seconds_count{status="succeeded"}'), 1);
    assert.equal(value('jig_service_run_seconds_count{status="stopped"}'), 1);
    assert.equal(value('jig_service_start_seconds_count{start="cold"}'), 2);
    assert.equal(value('jig_service_pool_takes_total{result="miss"}'), undefined, "no pool to miss");
    // Each end event says 20 in, 10 out and $0.002.
    assert.equal(value('jig_service_tokens_total{tenant="acme",kind="input"}'), 40);
    assert.equal(value('jig_service_tokens_total{tenant="acme",kind="output"}'), 20);
    assert.equal(value('jig_service_cost_usd_total{tenant="acme"}'), 0.004);

    // Requests by their route's template, never a task's id.
    assert.equal(value('jig_service_http_requests_total{route="/v1/tasks",status="201"}'), 3);
    assert.equal(value('jig_service_http_requests_total{route="/v1/tasks",status="429"}'), 2);
    assert.equal(value('jig_service_http_requests_total{route="/v1/tasks/:id/events",status="200"}'), 1);
    assert.equal(value('jig_service_http_requests_total{route="/v1/tasks/:id/cancel",status="404"}'), 1);
    assert.ok(value('jig_service_http_requests_total{route="/v1/tasks/:id",status="200"}')! >= 1);
    assert.ok(value('jig_service_http_request_seconds_count{route="/v1/tasks"}')! >= 7);
    for (const id of [first, second, held]) assert.ok(!text.includes(id), "no task's id in a label");
    for (const key of Object.values(KEYS)) assert.ok(!text.includes(key));
  });

  it("counts the approvals waiting for an answer, and how long each waited, by how it was answered", async () => {
    const api = await service({ tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], approvalTimeout: 120 }, { id: "globex", keys: [sha256(KEYS.globex)], approvalTimeout: 1 }] });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    await until(async () => (await call(api, KEYS.acme, "GET", `/v1/tasks/${id}/approvals`)).body.approvals.length, "an approval");
    assert.equal((await scrape(api)).value("jig_service_approvals_pending"), 1);
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 200);
    assert.equal((await scrape(api)).value("jig_service_approvals_pending"), 0);
    await ended(api, KEYS.acme, id);

    // Unanswered, globex's is denied at its timeout, a second on: timed by jig's clock, so the runner's
    // reads of its events, a poll apart and later under load, don't shorten it.
    const late = (await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
    await ended(api, KEYS.globex, late);
    const { value, text } = await scrape(api);
    assert.equal(value('jig_service_approval_wait_seconds_count{decision="allow"}'), 1);
    assert.equal(value('jig_service_approval_wait_seconds_count{decision="timeout"}'), 1);
    const waited = value('jig_service_approval_wait_seconds_sum{decision="timeout"}')!;
    assert.ok(waited >= 1 && waited < 10, `waited ${waited}`);
    assert.equal(value("jig_service_approvals_pending"), 0);
    assert.equal(value('jig_service_http_requests_total{route="/v1/tasks/:id/approvals/:aid",status="200"}'), 1);
    assert.ok(!text.includes("ap_1"));
  });

  it("times a timeout by the service's clock where the run's event times can't be right", async () => {
    // A run's commands may write its events: one asked years before the run, and one at no time.
    const runner: Runner = {
      async start() {
        const event = (seq: number, ts: string, type: string, fields: object) => ({ v: 1, seq, ts, type, ...fields });
        const now = () => new Date().toISOString();
        return {
          events: (async function* () {
            yield event(1, "2000-01-01T00:00:00.000Z", "approval_request", { step: 1, id: "ap_1", tool: "bash", description: "ls" });
            yield event(2, now(), "approval", { id: "ap_1", decision: "deny", always: false, by: "timeout" });
            yield event(3, "soon", "approval_request", { step: 1, id: "ap_2", tool: "bash", description: "ls" });
            yield event(4, now(), "approval", { id: "ap_2", decision: "deny", always: false, by: "timeout" });
            yield event(5, now(), "end", { stop: "done", steps: 1 });
          })(),
          wait: async () => ({ exitCode: 0, timedOut: false }),
          cancel: () => {},
        };
      },
    };
    const api = await service({}, runner);
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 2", approvals: true })).body.id;
    await ended(api, KEYS.acme, id);
    const { value } = await scrape(api);
    assert.equal(value('jig_service_approval_wait_seconds_count{decision="timeout"}'), 2);
    const waited = value('jig_service_approval_wait_seconds_sum{decision="timeout"}')!;
    assert.ok(waited >= 0 && waited < 10, `waited ${waited}`);
  });

  it("counts the replicas whose heartbeat is in the store, and forgets one that stops", async () => {
    const shared = await database(await tempDir("jig-observe-"));
    const first = await service({ database: shared });
    const second = await service({ database: shared });
    assert.equal((await scrape(first)).value("jig_service_replicas"), 2);
    services.splice(services.indexOf(second), 1);
    await second.close();
    assert.equal((await scrape(first)).value("jig_service_replicas"), 1);
  });
};

for (const { name, skip } of BACKENDS) {
  describe(`the task service's metrics (${name})`, { skip }, () => {
    beforeEach(() => void (backend = name));
    observeTests();
  });
}

describe("the task service's metrics listener, request ids and logs", () => {
  beforeEach(() => void (backend = "SQLite"));

  it("serves the metrics only on a listener of their own, which is off without the config's block", async () => {
    const off = await service({ metrics: undefined });
    assert.equal(off.metricsUrl, undefined);
    assert.equal((await call(off, undefined, "GET", "/metrics")).status, 401);
    assert.equal((await call(off, KEYS.acme, "GET", "/metrics")).status, 404);
    assert.equal((await fetch(`${off.internalUrl}/metrics`)).status, 404, "never where the tasks reach");

    const on = await service();
    assert.notEqual(on.metricsUrl, on.url);
    assert.match(on.metricsUrl!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(await (await fetch(`${on.metricsUrl}/healthz`)).json(), { ok: true });
    for (const [method, path] of [["GET", "/v1/tasks"], ["POST", "/metrics"], ["GET", "/metrics/x"], ["GET", "/internal/approvals/ap_1"]]) {
      assert.equal((await fetch(on.metricsUrl + path, { method })).status, 404, `${method} ${path}`);
    }
    // Every metric the service has is there, with its help and type, before anything has happened.
    const { text } = await scrape(on);
    const types = (text: string) => [...text.matchAll(/^# TYPE (\S+) \S+$/gm)].map(([, name]) => name);
    assert.deepEqual(types(text), types(await serviceMetrics().registry.render()));
    for (const name of types(text)) assert.match(name, /^jig_service_/);

    for (const [metrics, error] of [[{}, /metrics\.port is missing/], [{ port: "9180" }, /metrics\.port must be a whole number/], [{ port: 9180, host: 1 }, /metrics\.host must be a string/], [[9180], /metrics must be an object/]] as const) {
      assert.throws(() => checkConfig({ database: "x", dataDir: "x", gatewayBaseUrl: "http://gateway", tenants: [], metrics } as never), error, JSON.stringify(metrics));
    }
  });

  it("counts requests under their route's template", () => {
    const paths: [string, string][] = [
      ["/v1/tasks", "/v1/tasks"],
      ["/v1/tasks/task_1", "/v1/tasks/:id"],
      ["/v1/tasks/task_1/events", "/v1/tasks/:id/events"],
      ["/v1/tasks/task_1/cancel", "/v1/tasks/:id/cancel"],
      ["/v1/tasks/task_1/approvals", "/v1/tasks/:id/approvals"],
      ["/v1/tasks/task_1/approvals/ap_1", "/v1/tasks/:id/approvals/:aid"],
      ["/v1/usage", "/v1/usage"],
      ["/admin/usage", "/admin/usage"],
      ["/healthz", "other"],
      ["/v1/tasks/task_1/stats", "other"],
      ["/v1/tasks/a b", "other"],
      ["/favicon.ico", "other"],
    ];
    for (const [path, route] of paths) assert.equal(routeOf(path), route, path);
    assert.deepEqual(new Set(paths.map(([, route]) => route)), new Set(ROUTES));
  });

  it("answers every request with an x-request-id, the client's if it is one, and logs JSON lines with the request, tenant and task", async () => {
    const api = await service();
    const given = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" }, { "x-request-id": "req-1.a_b" });
    assert.equal(given.headers.get("x-request-id"), "req-1.a_b");
    const id = given.body.id;
    for (const bad of ["two words", "x".repeat(129), "a/b"]) {
      const made = (await call(api, KEYS.acme, "GET", "/v1/tasks", undefined, { "x-request-id": bad })).headers.get("x-request-id");
      assert.match(made!, /^[\w.-]{1,128}$/);
      assert.notEqual(made, bad);
    }
    const own = (await call(api, undefined, "GET", "/v1/tasks")).headers.get("x-request-id");
    assert.match(own!, /^[0-9a-f-]{36}$/);
    for (const url of [`${api.internalUrl}/healthz`, `${api.metricsUrl}/metrics`]) assert.match((await fetch(url)).headers.get("x-request-id")!, /^[0-9a-f-]{36}$/);
    await ended(api, KEYS.acme, id);

    // A request's line, at debug, with its id and tenant; the task's, with its id and tenant.
    const access = await until(() => api.lines.find((line) => line.msg === "request" && line.request === "req-1.a_b"), "the request's line");
    assert.deepEqual({ ...access, ts: undefined, ms: undefined }, { ts: undefined, level: "debug", component: "service", msg: "request", request: "req-1.a_b", method: "POST", path: "/v1/tasks", status: 201, ms: undefined, tenant: "acme" });
    assert.ok(api.lines.some((line) => line.msg === "request" && line.request === own && line.status === 401 && !("tenant" in line)));
    const done = await until(() => api.lines.find((line) => line.msg === "task ended" && line.task === id), "the task's line");
    assert.deepEqual([done.level, done.tenant, done.status], ["debug", "acme", "succeeded"]);

    // A request that fails is a 500, and an error line with the error and the request.
    api.store.tasks = async () => {
      throw new Error("the database is away");
    };
    const failed = await call(api, KEYS.acme, "GET", "/v1/tasks", undefined, { "x-request-id": "req-2" });
    assert.equal(failed.status, 500);
    const error = api.lines.find((line) => line.level === "error" && line.request === "req-2");
    assert.equal(error.msg, "request failed");
    assert.equal(error.err.message, "the database is away");
    assert.equal(error.tenant, "acme");
    assert.equal((await scrape(api)).value('jig_service_http_requests_total{route="/v1/tasks",status="500"}'), 1);
  });
});

describe("the task service's metrics on the Docker runner, with a warm pool", () => {
  beforeEach(() => void (backend = "SQLite"));

  it("counts tasks a warm worker took and those that started cold, and how long each took to start", async () => {
    const base = await tempDir("jig-observe-docker-");
    const state = join(base, "state");
    await mkdir(state);
    // A container takes a second to exist: the pool's one was there before the first task came, the
    // second's place isn't filled yet when the second comes.
    await writeFile(join(state, "delay"), "1000");
    const runner = new DockerRunner({ dataDir: join(base, "data"), docker: [process.execPath, FAKE_DOCKER, state], image: "jig-worker:test", network: "jig-tasks", gatewayBaseUrl: "http://gateway:8081/anthropic", gatewaySecret: SECRET, graceSeconds: 5, pollMs: 20, pool: { size: 1 } });
    const api = await service({ dataDir: join(base, "data") }, runner);
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    assert.equal((await scrape(api)).value("jig_service_pool_idle"), 1);
    const warm = (await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    const cold = (await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    for (const id of [warm, cold]) assert.equal((await ended(api, KEYS.globex, id)).status, "succeeded");
    const { value } = await scrape(api);
    assert.equal(value('jig_service_pool_takes_total{result="hit"}'), 1);
    assert.equal(value('jig_service_pool_takes_total{result="miss"}'), 1);
    assert.equal(value('jig_service_start_seconds_count{start="warm"}'), 1);
    assert.equal(value('jig_service_start_seconds_count{start="cold"}'), 1);
    // The cold one waited for its container, the warm one didn't.
    assert.ok(value('jig_service_start_seconds_sum{start="cold"}')! >= 1);
    assert.ok(value('jig_service_start_seconds_sum{start="warm"}')! < value('jig_service_start_seconds_sum{start="cold"}')!);
  });

  it("writes the warm pool's and the approval webhooks' lines to the service's log, with their task", async () => {
    const base = await tempDir("jig-observe-docker-");
    const state = join(base, "state");
    await mkdir(state);
    // No container exists for a second, so the task finds no warm worker waiting.
    await writeFile(join(state, "delay"), "1000");
    const receiver = createServer((req, res) => void req.resume().on("end", () => res.writeHead(500).end()));
    await new Promise<void>((done) => receiver.listen(0, "127.0.0.1", done));
    const saved = process.env.ACME_WEBHOOK_SECRET;
    process.env.ACME_WEBHOOK_SECRET = "acme's webhook secret";
    try {
      const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
      // The runner is the one the config names, as in production.
      const api = await service(
        {
          dataDir: join(base, "data"),
          runner: "docker",
          docker: { image: "jig-worker:test", network: "jig-tasks", docker: [process.execPath, FAKE_DOCKER, state], pollMs: 20, pool: { size: 1 } },
          tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], approvalWebhook: url, webhookSecretEnv: "ACME_WEBHOOK_SECRET" }],
        },
        undefined,
        { webhookRetryMs: 10 },
      );
      const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "ask 1", approvals: true })).body.id;
      const missed = await until(() => api.lines.find((line) => line.msg.startsWith("no warm worker was waiting")), "the pool's line");
      assert.deepEqual([missed.level, missed.component, missed.task], ["info", "service", id]);
      const failed = await until(() => api.lines.find((line) => line.msg.startsWith("the approval webhook failed")), "the webhook's line");
      assert.deepEqual([failed.level, failed.msg, failed.tenant, failed.task], ["warn", "the approval webhook failed for ap_1, 4 times: 500", "acme", id]);
    } finally {
      if (saved === undefined) delete process.env.ACME_WEBHOOK_SECRET;
      else process.env.ACME_WEBHOOK_SECRET = saved;
      await new Promise((done) => (receiver.closeAllConnections(), receiver.close(done)));
    }
  });
});

describe("the observability deploy files", () => {
  // The gateway's and the router's metrics, as their contracts name them (docs/server.md), histograms
  // marked: the files below cover all three parts.
  const GATEWAY = ["jig_gateway_requests_total", "jig_gateway_request_seconds:h", "jig_gateway_first_byte_seconds:h", "jig_gateway_queue_seconds:h", "jig_gateway_inflight", "jig_gateway_waiting", "jig_gateway_tokens_total", "jig_gateway_cost_usd_total", "jig_gateway_failovers_total", "jig_gateway_upstream_open", "jig_gateway_keys", "jig_gateway_refused_total", "jig_gateway_state_errors_total"];
  const ROUTER = ["jig_router_requests_total", "jig_router_region_up", "jig_router_failovers_total", "jig_router_request_seconds:h"];

  /** Every series name a query may use: the service's registrations, those in the server's code, and the contracts'. */
  async function known(): Promise<Set<string>> {
    const names = new Set<string>();
    const add = (name: string, histogram: boolean) => {
      names.add(name);
      if (histogram) for (const suffix of ["_bucket", "_sum", "_count"]) names.add(name + suffix);
    };
    for (const [, name, type] of (await serviceMetrics().registry.render()).matchAll(/^# TYPE (\S+) (\S+)$/gm)) add(name, type === "histogram");
    for (const entry of [...GATEWAY, ...ROUTER]) add(entry.replace(/:h$/, ""), entry.endsWith(":h"));
    const server = join(import.meta.dirname, "..", "server");
    for (const file of (await readdir(server)).filter((name) => name.endsWith(".ts"))) {
      for (const [, name] of (await readFile(join(server, file), "utf8")).matchAll(/"(jig_(?:gateway|router)_[a-z_]+)"/g)) add(name, name.endsWith("_seconds"));
    }
    return names;
  }
  const used = (query: string) => [...query.matchAll(/\bjig_[a-z_]+/g)].map(([name]) => name);
  const read = async (file: string) => readFile(join(DEPLOY, file), "utf8");

  it("alert on the service's, the gateway's and the router's metrics, by the names they have", async () => {
    const names = await known();
    const [{ groups }] = parseYaml(await read("observability/alerts.yml")) as any[];
    assert.deepEqual(groups.map((group: any) => group.name), ["jig-service", "jig-gateway", "jig-router"]);
    const alerts = groups.flatMap((group: any) => group.rules);
    assert.equal(new Set(alerts.map((rule: any) => rule.alert)).size, alerts.length, "each alert's name is its own");
    for (const rule of alerts) {
      assert.deepEqual(Object.keys(rule).filter((key) => !["alert", "expr", "for", "labels", "annotations"].includes(key)), [], rule.alert);
      assert.match(rule.alert, /^Jig[A-Z]\w+$/);
      assert.ok(["info", "warning", "critical"].includes(rule.labels.severity), rule.alert);
      assert.ok(rule.annotations.summary && rule.annotations.description, rule.alert);
      if (rule.for !== undefined) assert.match(rule.for, /^\d+[smh]$/, rule.alert);
      for (const name of used(rule.expr)) assert.ok(names.has(name), `${rule.alert}: ${name} isn't a metric`);
    }
    // What the proposal asks to be told of, each part's.
    const exprs = alerts.map((rule: any) => rule.expr).join("\n");
    for (const name of ["jig_service_queue_oldest_seconds", "jig_service_queue_seconds_bucket", "jig_service_tasks_ended_total", "jig_service_store_errors_total", "jig_service_lease_errors_total", "jig_service_tasks_refused_total", "jig_gateway_requests_total", "jig_gateway_failovers_total", "jig_gateway_upstream_open", "jig_gateway_keys", "jig_gateway_refused_total", "jig_router_region_up"]) {
      assert.ok(used(exprs).includes(name), name);
    }
  });

  it("chart every metric of the service's, and only metrics that are, on a dashboard Grafana can import", async () => {
    const names = await known();
    const dashboard = JSON.parse(await read("observability/grafana-dashboard.json"));
    assert.equal(dashboard.uid, "jig-fleet");
    const panels = dashboard.panels.filter((panel: any) => panel.type !== "row");
    assert.equal(new Set(dashboard.panels.map((panel: any) => panel.id)).size, dashboard.panels.length, "each panel's id is its own");
    const queries: string[] = [];
    for (const panel of panels) {
      const { x, w } = panel.gridPos;
      assert.ok(x >= 0 && x + w <= 24, panel.title);
      assert.equal(panel.datasource.uid, "${datasource}");
      assert.ok(panel.targets.length, panel.title);
      for (const target of panel.targets) {
        assert.match(target.refId, /^[A-Z]$/);
        for (const name of used(target.expr)) assert.ok(names.has(name), `${panel.title}: ${name} isn't a metric`);
        queries.push(target.expr);
      }
    }
    const charted = new Set(queries.flatMap(used).map((name) => name.replace(/_(bucket|sum|count)$/, "")));
    for (const [, name] of (await serviceMetrics().registry.render()).matchAll(/^# TYPE (\S+) \S+$/gm)) assert.ok(charted.has(name), `${name} isn't charted`);
    for (const entry of [...GATEWAY, ...ROUTER]) assert.ok(charted.has(entry.replace(/:h$/, "")), `${entry} isn't charted`);
  });

  it("scrape the metrics ports the Kubernetes files open, which only the monitoring namespace reaches", async () => {
    const [prometheus] = parseYaml(await read("observability/prometheus.yml")) as any[];
    assert.deepEqual(prometheus.rule_files, ["alerts.yml"]);
    const [pods, fixed] = prometheus.scrape_configs;
    assert.deepEqual(pods.relabel_configs[0], { source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"], action: "keep", regex: "true" });
    const address = pods.relabel_configs[1];
    assert.equal("10.0.0.7:8080;9180".replace(new RegExp(`^(?:${address.regex})$`), address.replacement), "10.0.0.7:9180");

    const all: any[] = [];
    for (const file of ["api.yaml", "gateway.yaml", "config.yaml", "networkpolicy.yaml"]) all.push(...(parseYaml(await read(join("k8s", file))) as any[]));
    const find = (kind: string, name: string) => all.find((doc) => doc.kind === kind && doc.metadata.name === name);
    const configs = { api: JSON.parse(find("ConfigMap", "jig-config").data["service.json"]), gateway: JSON.parse(find("ConfigMap", "jig-gateway-config").data["gateway.json"]) };
    for (const [component, config] of Object.entries(configs)) {
      const { port, host } = config.metrics;
      assert.equal(host, "0.0.0.0", "reached at the pod's address");
      const pod = find("Deployment", `jig-${component}`).spec.template;
      assert.deepEqual(pod.metadata.annotations, { "prometheus.io/scrape": "true", "prometheus.io/port": String(port) });
      assert.ok(pod.spec.containers[0].ports.some((open: any) => open.containerPort === port && open.name === "metrics"), component);
      // No Service sends anything to it: Prometheus scrapes each pod.
      assert.ok(!find("Service", `jig-${component}`).spec.ports.some((open: any) => open.port === port));
      assert.ok(fixed.static_configs.some((group: any) => group.labels.component === component && group.targets.every((target: string) => target.endsWith(`:${port}`))), component);

      // Only the monitoring namespace reaches it; what reached the pod before still does.
      const policy = find("NetworkPolicy", `jig-${component}`).spec;
      assert.deepEqual(policy.podSelector.matchLabels, pod.metadata.labels);
      assert.deepEqual(policy.policyTypes, ["Ingress"]);
      const from = (wanted: number) => policy.ingress.filter((rule: any) => rule.ports.some((open: any) => open.port === wanted)).map((rule: any) => rule.from ?? "anywhere");
      assert.deepEqual(from(port), [[{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "monitoring" } } }]]);
      const served = component === "api" ? { [configs.api.port]: "anywhere", [configs.api.internal.port]: [{ podSelector: {} }] } : { [configs.gateway.listen.port]: [{ podSelector: {} }] };
      for (const [open, sources] of Object.entries(served)) assert.deepEqual(from(Number(open)), [sources], `${component} ${open}`);
    }
  });
});
