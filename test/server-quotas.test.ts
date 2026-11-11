import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checkConfig, type Config, type Service, startService } from "../server/api.ts";
import { Pool } from "../server/pg.ts";
import { openStore } from "../server/store.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The task service's quotas (tasks a tenant may create in a UTC day, USD it may spend in a day or a month),
// the usage ledger they and billing read (a row per ended task), and the usage reports for tenants and for
// an admin. With the fake jig (fixtures/fake-jig.mjs), whose every run costs $0.002 for 20 tokens in and 10
// out; no model is called. On SQLite, and on Postgres where JIG_TEST_POSTGRES_URL names one.

const FAKE_JIG = join(import.meta.dirname, "fixtures", "fake-jig.mjs");
const SECRET = "the gateway's secret";
const KEYS = { acme: "acme-key", globex: "globex-key" };
const ADMIN = "the-admin-key";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const services: Service[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await removeTempDirs();
  await dropPostgresDatabases();
  delete process.env.JIG_TEST_ADMIN_KEY;
});

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;
let backend: (typeof BACKENDS)[number]["name"] = "SQLite";

/** The service's clock, which the tests move on to the next day or month; the real one when unset. */
let clock: Date | undefined;

async function database(): Promise<string> {
  return backend === "SQLite" ? join(await tempDir("jig-quotas-"), "jig.db") : postgresDatabase();
}

/** A service with the fake jig and two tenants, acme with `quotas`, on a database of its own unless given. */
async function service(quotas: object | undefined, config: Partial<Config> = {}): Promise<Service & { database: string }> {
  const db = config.database ?? (await database());
  const started = await startService(
    {
      port: 0,
      internal: { port: 0 },
      database: db,
      dataDir: join(await tempDir("jig-quotas-"), "data"),
      gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
      jig: [process.execPath, FAKE_JIG],
      graceSeconds: 5,
      concurrency: 4,
      tenants: [
        { id: "acme", keys: [sha256(KEYS.acme)], concurrency: 4, ...(quotas && { quotas }) },
        { id: "globex", keys: [sha256(KEYS.globex)] },
      ],
      ...config,
    },
    { secret: SECRET, now: () => clock ?? new Date() },
  );
  services.push(started);
  return { ...started, database: db };
}

async function call(service: Service, key: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(service.url + path, {
    method,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: res.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : text, headers: res.headers };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Posts a task that ends at once, and waits for it to end; its id. */
async function ran(service: Service, key: string, body: object = {}): Promise<string> {
  const created = await call(service, key, "POST", "/v1/tasks", { prompt: "exit 0", ...body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await until(async () => (await call(service, key, "GET", `/v1/tasks/${created.body.id}`)).body.ended, `${created.body.id} to end`);
  return created.body.id;
}

/** Runs `sql` on the service's database through a connection of the test's own, as an operator would. */
async function sql(database: string, text: string, params: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  if (backend === "Postgres") {
    const pool = new Pool(database);
    try {
      return (await pool.query(text.replace(/\?/g, (_, offset: number) => `$${text.slice(0, offset).split("?").length}`), params)).rows;
    } finally {
      await pool.close();
    }
  }
  const db = new DatabaseSync(database);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(text).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const nextDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
const nextMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const quotaTests = () => {
  it("refuses the task past tasksPerDay with 429, the quota and when it resets, and takes them again the next day", async () => {
    clock = new Date();
    const api = await service({ tasksPerDay: 2 });
    for (let i = 0; i < 2; i++) assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
    const refused = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(refused.status, 429);
    const resetsAt = nextDay(clock).toISOString();
    assert.deepEqual({ ...refused.body, error: undefined }, { error: undefined, quota: "tasksPerDay", limit: 2, used: 2, resetsAt });
    assert.match(refused.body.error, /created 2 tasks today/);
    assert.equal(refused.headers.get("retry-after"), String(Math.ceil((Date.parse(resetsAt) - clock.getTime()) / 1000)));
    // Another tenant's day is its own.
    assert.equal((await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
    clock = new Date(resetsAt);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
  });

  it("counts tasksPerDay by the service's clock, which stamps the tasks it creates too", async () => {
    // The last second of a year: a task stamped by another clock (the database's, the machine's) would
    // be counted on some other day.
    clock = new Date("2026-12-31T23:59:59Z");
    const api = await service(undefined, { tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0, quotas: { tasksPerDay: 1 } }] });
    const created = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(created.status, 201);
    assert.equal((await api.store.task(created.body.id))!.created, clock.toISOString());
    const refused = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.deepEqual([refused.status, refused.body.quota, refused.body.used], [429, "tasksPerDay", 1]);
  });

  it("refuses new tasks once what the tenant's tasks spent today reaches usdPerDay, until the next day", async () => {
    clock = new Date();
    const api = await service({ usdPerDay: 0.004 });
    await ran(api, KEYS.acme);
    await ran(api, KEYS.acme);
    const refused = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(refused.status, 429);
    assert.deepEqual([refused.body.quota, refused.body.limit, refused.body.used, refused.body.resetsAt], ["usdPerDay", 0.004, 0.004, nextDay(clock).toISOString()]);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    clock = nextDay(clock);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
  });

  it("refuses new tasks once what the tenant's tasks spent this month reaches usdPerMonth, until the next month", async () => {
    clock = new Date();
    const api = await service({ usdPerMonth: 0.004, usdPerDay: 1 });
    await ran(api, KEYS.acme);
    await ran(api, KEYS.acme);
    const refused = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.deepEqual([refused.status, refused.body.quota, refused.body.used, refused.body.resetsAt], [429, "usdPerMonth", 0.004, nextMonth(clock).toISOString()]);
    // The next day, if it is in the same month, is no reset.
    if (nextDay(clock) < nextMonth(clock)) {
      clock = nextDay(clock);
      assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.quota, "usdPerMonth");
    }
    clock = nextMonth(clock);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
  });

  it("holds tasksPerDay across two replicas on one database, under concurrent posts", async () => {
    clock = new Date();
    const db = await database();
    // Nothing runs: the tasks stay queued, and the quota counts them all the same.
    const config = { database: db, tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0, quotas: { tasksPerDay: 5 } }] };
    const [one, two] = [await service(undefined, config), await service(undefined, config)];
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? one : two, KEYS.acme, "POST", "/v1/tasks", { prompt: `exit 0 (${i})` })));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [...Array(5).fill(201), ...Array(15).fill(429)]);
    assert.equal((await one.store.tasks("acme")).length, 5);
  });

  it("writes a row of the ledger for every task that ends, once, however it ends", async () => {
    clock = new Date();
    const api = await service(undefined, { tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 1 }] });
    const succeeded = await ran(api, KEYS.acme, { model: "claude-haiku-4-5" });
    const failed = await ran(api, KEYS.acme, { prompt: "exit 1" });
    // One that waits, and one queued behind it, cancelled before it starts.
    const waiting = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    const queued = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${queued}/cancel`)).status, 200);
    await until(async () => (await call(api, KEYS.acme, "GET", `/v1/tasks/${waiting}`)).body.status === "running", "the task to run");
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${waiting}/cancel`)).status, 202);
    await until(async () => (await call(api, KEYS.acme, "GET", `/v1/tasks/${waiting}`)).body.status === "cancelled", "the cancel");
    await api.scheduler.settled();

    const rows = await sql(api.database, "SELECT * FROM usage");
    const today = clock.toISOString().slice(0, 10);
    const byTask = new Map(rows.map((row) => [row.task, row]));
    assert.equal(rows.length, 4);
    const fields = (id: string) => {
      const { tenant, day, model, status, input, output, cache_read, cache_write, cost_usd } = byTask.get(id)!;
      return [tenant, day, model, status, Number(input), Number(output), Number(cache_read), Number(cache_write), Number(cost_usd)];
    };
    assert.deepEqual(fields(succeeded), ["acme", today, "claude-haiku-4-5", "succeeded", 20, 10, 0, 0, 0.002]);
    assert.deepEqual(fields(failed), ["acme", today, "deepseek-flash", "error", 20, 10, 0, 0, 0.002]);
    assert.deepEqual(fields(waiting), ["acme", today, "deepseek-flash", "cancelled", 0, 0, 0, 0, 0]);
    assert.deepEqual(fields(queued), ["acme", today, "deepseek-flash", "cancelled", 0, 0, 0, 0, 0]);
    assert.equal(Number(byTask.get(queued)!.seconds), 0);
    assert.ok(Number(byTask.get(succeeded)!.seconds) > 0);

    // A replica that finishes a task another has ended already (its lease ran out meanwhile) adds nothing.
    const outcome = { status: "succeeded" as const, exitCode: 0, stop: "end_turn", error: null, stats: null, usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 1000 }, cost: 5 };
    await api.store.finish(succeeded, api.scheduler.replicaId, outcome);
    assert.equal((await sql(api.database, "SELECT count(*) AS n FROM usage")).map((row) => Number(row.n))[0], 4);
    assert.equal(Number((await sql(api.database, "SELECT cost_usd FROM usage WHERE task = ?", [succeeded]))[0].cost_usd), 0.002);
  });

  it("keeps one row for a task whose lease ran out and whose replica then finishes it, and takes no garbage from its end event", async () => {
    const db = await database();
    const store = await openStore(db);
    try {
      await store.putTenant({ id: "acme", limits: { concurrency: 2, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
      const lost = await store.createTask("acme", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "claude-haiku-4-5" });
      const odd = await store.createTask("acme", { prompt: "a1", maxSteps: 5, timeLimit: 60, model: "claude-haiku-4-5" });
      for (let i = 0; i < 2; i++) await store.claim("acme", { owner: i ? "slow" : "gone", leaseMs: i ? 60_000 : 1, concurrency: 4, tenantConcurrency: 2 });
      await new Promise((done) => setTimeout(done, 20));
      // Not while its lease ran out within the grace.
      assert.deepEqual(await store.expire("its replica is gone", 60_000), []);
      assert.deepEqual(await store.expire("its replica is gone"), [lost.id]);
      const spent = { status: "succeeded" as const, exitCode: 0, stop: "end_turn", error: null, stats: null, usage: { input: 5, cacheRead: 0, cacheWrite: 0, output: 5 }, cost: 1 };
      await store.finish(lost.id, "gone", spent);
      // What a task's commands might write as jig's end event, on Docker or Kubernetes.
      await store.finish(odd.id, "slow", { ...spent, usage: { input: -1, cacheRead: 1.5, cacheWrite: "lots", output: 1e300 } as never, cost: Number.NaN });
      const rows = await sql(db, "SELECT task, status, input, output, cache_read, cache_write, cost_usd FROM usage ORDER BY status");
      assert.deepEqual(
        rows.map((row) => Object.values(row).map((value) => (typeof value === "string" ? value : Number(value)))),
        [
          [lost.id, "error", 0, 0, 0, 0, 0],
          [odd.id, "succeeded", 0, 0, 0, 0, 0],
        ],
      );
    } finally {
      await store.close();
    }
  });

  it("reports a tenant's usage by day, model or both, over a range, as JSON or CSV, and never another tenant's", async () => {
    const api = await service(undefined);
    const ids = [await ran(api, KEYS.acme, { model: "claude-haiku-4-5" }), await ran(api, KEYS.acme, { model: "claude-haiku-4-5" }), await ran(api, KEYS.acme, { model: "claude-sonnet-4-5" })];
    await ran(api, KEYS.globex, { model: "claude-haiku-4-5" });
    // Moved to days in March, with run times that don't vary.
    for (const [id, day] of [[ids[0], "2026-03-01"], [ids[1], "2026-03-02"], [ids[2], "2026-03-02"]]) await sql(api.database, "UPDATE usage SET day = ?, seconds = 1.5 WHERE task = ?", [day, id]);
    await sql(api.database, "UPDATE usage SET day = '2026-03-02', seconds = 1.5 WHERE tenant = 'globex'");
    const sums = (tasks: number) => ({ tasks, input: 20 * tasks, output: 10 * tasks, cacheRead: 0, cacheWrite: 0, costUsd: 0.002 * tasks, seconds: 1.5 * tasks });
    const range = "from=2026-03-01&to=2026-03-31";

    assert.deepEqual((await call(api, KEYS.acme, "GET", `/v1/usage?${range}`)).body, {
      from: "2026-03-01",
      to: "2026-03-31",
      rows: [{ day: "2026-03-01", ...sums(1) }, { day: "2026-03-02", ...sums(2) }],
      total: { ...sums(3), costUsd: 0.006 },
    });
    assert.deepEqual((await call(api, KEYS.acme, "GET", `/v1/usage?${range}&group=model`)).body.rows, [{ model: "claude-haiku-4-5", ...sums(2) }, { model: "claude-sonnet-4-5", ...sums(1) }]);
    assert.deepEqual((await call(api, KEYS.acme, "GET", `/v1/usage?${range}&group=day,model`)).body.rows, [
      { day: "2026-03-01", model: "claude-haiku-4-5", ...sums(1) },
      { day: "2026-03-02", model: "claude-haiku-4-5", ...sums(1) },
      { day: "2026-03-02", model: "claude-sonnet-4-5", ...sums(1) },
    ]);
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/usage?from=2026-03-02&to=2026-03-02")).body.rows, [{ day: "2026-03-02", ...sums(2) }]);
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/usage?from=2026-04-01&to=2026-04-30")).body, { from: "2026-04-01", to: "2026-04-30", rows: [], total: sums(0) });
    // This month to today by the service's clock, when no range is given.
    clock = new Date("2026-03-01T12:00:00Z");
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/usage")).body, { from: "2026-03-01", to: "2026-03-01", rows: [{ day: "2026-03-01", ...sums(1) }], total: sums(1) });
    // globex sees its own task only.
    assert.deepEqual((await call(api, KEYS.globex, "GET", `/v1/usage?${range}&group=model`)).body.rows, [{ model: "claude-haiku-4-5", ...sums(1) }]);

    const csv = await call(api, KEYS.acme, "GET", `/v1/usage?${range}&group=day,model&format=csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type")!, /^text\/csv/);
    assert.equal(
      csv.body,
      "day,model,tasks,input,output,cacheRead,cacheWrite,costUsd,seconds\r\n" +
        "2026-03-01,claude-haiku-4-5,1,20,10,0,0,0.002,1.5\r\n2026-03-02,claude-haiku-4-5,1,20,10,0,0,0.002,1.5\r\n2026-03-02,claude-sonnet-4-5,1,20,10,0,0,0.002,1.5\r\n",
    );
    // A cost too small for String's plain digits is written in them all the same, never as 1e-7.
    await sql(api.database, "UPDATE usage SET cost_usd = 0.0000001 WHERE task = ?", [ids[0]]);
    const tiny = await call(api, KEYS.acme, "GET", "/v1/usage?from=2026-03-01&to=2026-03-01&format=csv");
    assert.equal(tiny.body, "day,tasks,input,output,cacheRead,cacheWrite,costUsd,seconds\r\n2026-03-01,1,20,10,0,0,0.0000001,1.5\r\n");

    assert.equal((await call(api, KEYS.acme, "GET", "/v1/usage?from=2024-01-01&to=2024-12-31")).status, 200);
    for (const query of ["from=2025-01-01&to=2026-01-02", "from=2026-02-30", "from=yesterday", "from=2026-03-02&to=2026-03-01", "group=tenant", "group=model,day", "format=xml", "tenant=globex", "to=2026-3-1", "from=2026-03-01&from=2026-03-02"]) {
      const { status, body } = await call(api, KEYS.acme, "GET", `/v1/usage?${query}`);
      assert.equal(status, 400, query);
      assert.ok(body.error, query);
    }
    assert.equal((await call(api, undefined, "GET", "/v1/usage")).status, 401);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/usage")).status, 405);
  });

  it("reports every tenant's usage to the admin key, or one tenant's, and has no /admin without one", async () => {
    const plain = await service(undefined);
    for (const key of [undefined, KEYS.acme, ADMIN]) assert.equal((await call(plain, key, "GET", "/admin/usage")).status, 404);

    await assert.rejects(service(undefined, { adminKeyEnv: "JIG_TEST_ADMIN_KEY" }), /Set JIG_TEST_ADMIN_KEY/);
    // A Bearer is one word, so a key with whitespace (a Secret's trailing newline) could never be given.
    process.env.JIG_TEST_ADMIN_KEY = `${ADMIN}\n`;
    await assert.rejects(service(undefined, { adminKeyEnv: "JIG_TEST_ADMIN_KEY" }), /JIG_TEST_ADMIN_KEY holds whitespace \(a trailing newline\?\): the admin key can't hold any/);
    process.env.JIG_TEST_ADMIN_KEY = ADMIN;
    const api = await service(undefined, { adminKeyEnv: "JIG_TEST_ADMIN_KEY" });
    await ran(api, KEYS.acme, { model: "claude-haiku-4-5" });
    await ran(api, KEYS.globex, { model: "claude-haiku-4-5" });
    await ran(api, KEYS.globex, { model: "claude-sonnet-4-5" });
    await sql(api.database, "UPDATE usage SET day = '2026-03-02', seconds = 2");
    for (const key of [undefined, KEYS.acme, "not the admin key"]) assert.equal((await call(api, key, "GET", "/admin/usage?from=2026-03-01&to=2026-03-31")).status, 401);
    // Every tenant's report reads the ledger by day alone, through an index of its own.
    const index = backend === "SQLite" ? "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'usage_by_day'" : "SELECT to_regclass('usage_by_day')::text AS name";
    assert.deepEqual((await sql(api.database, index)).map((row) => row.name), ["usage_by_day"]);

    const all = await call(api, ADMIN, "GET", "/admin/usage?from=2026-03-01&to=2026-03-31&group=model");
    assert.equal(all.status, 200);
    const sums = { tasks: 1, input: 20, output: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.002, seconds: 2 };
    assert.deepEqual(all.body.rows, [
      { tenant: "acme", model: "claude-haiku-4-5", ...sums },
      { tenant: "globex", model: "claude-haiku-4-5", ...sums },
      { tenant: "globex", model: "claude-sonnet-4-5", ...sums },
    ]);
    assert.equal(all.body.total.tasks, 3);
    const one = await call(api, ADMIN, "GET", "/admin/usage?from=2026-03-01&to=2026-03-31&tenant=globex");
    assert.deepEqual(one.body.rows, [{ tenant: "globex", day: "2026-03-02", ...sums, tasks: 2, input: 40, output: 20, costUsd: 0.004, seconds: 4 }]);
    const csv = await call(api, ADMIN, "GET", "/admin/usage?from=2026-03-01&to=2026-03-31&tenant=acme&format=csv");
    assert.equal(csv.body, "tenant,day,tasks,input,output,cacheRead,cacheWrite,costUsd,seconds\r\nacme,2026-03-02,1,20,10,0,0,0.002,2\r\n");
    assert.equal((await call(api, ADMIN, "GET", "/admin/usage?from=x")).status, 400);
    // A parameter given twice isn't read as its first.
    const twice = await call(api, ADMIN, "GET", "/admin/usage?from=2026-03-01&to=2026-03-31&tenant=acme&tenant=globex");
    assert.deepEqual([twice.status, twice.body], [400, { error: "tenant may be given once" }]);
    assert.equal((await call(api, ADMIN, "GET", "/admin/other")).status, 404);
    // The admin key opens no tenant's tasks.
    assert.equal((await call(api, ADMIN, "GET", "/v1/tasks")).status, 401);
  });

  /** A create with an Idempotency-Key. */
  const keyed = (api: Service, tenant: string, key: string, body: object = { prompt: "exit 0" }) => call(api, tenant, "POST", "/v1/tasks", body, { "idempotency-key": key });
  const idle = { tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0 }, { id: "globex", keys: [sha256(KEYS.globex)], concurrency: 0 }] };

  it("makes one task for a tenant's Idempotency-Key: the same body again is answered with it, another body with 422", async () => {
    const api = await service(undefined, idle);
    const first = await keyed(api, KEYS.acme, "order-1");
    assert.deepEqual([first.status, first.body.status, first.headers.get("idempotent-replay")], [201, "queued", null]);
    const again = await keyed(api, KEYS.acme, "order-1");
    assert.deepEqual([again.status, again.body, again.headers.get("idempotent-replay")], [200, { id: first.body.id, status: "queued" }, "true"]);
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/tasks")).body.tasks.map((task: any) => task.id), [first.body.id]);

    // Compared as bytes: a body that says anything else is another request, and makes nothing.
    const other = await keyed(api, KEYS.acme, "order-1", { prompt: "exit 1" });
    assert.deepEqual([other.status, other.body], [422, { error: `Idempotency-Key order-1 was used with a different body, for task ${first.body.id}: use a new key for a new task`, id: first.body.id }]);
    assert.equal((await api.store.tasks("acme")).length, 1);

    // A key is its tenant's: another's use of the same one is a task of its own.
    const theirs = await keyed(api, KEYS.globex, "order-1");
    assert.equal(theirs.status, 201);
    assert.notEqual(theirs.body.id, first.body.id);
    // And a create without one is a new task each time, as before.
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
    assert.equal((await api.store.tasks("acme")).length, 2);
  });

  it("refuses an Idempotency-Key that isn't 1 to 128 of its characters with 400, and makes no task", async () => {
    const api = await service(undefined, idle);
    // The last is a header sent twice, as the service reads it: its two values, joined.
    for (const key of ["", "k".repeat(129), "two words", "order-1, order-1"]) {
      const refused = await keyed(api, KEYS.acme, key);
      assert.deepEqual([refused.status, refused.body], [400, { error: "Idempotency-Key must be 1 to 128 of letters, digits, _ . : -" }], JSON.stringify(key));
    }
    assert.equal((await api.store.tasks("acme")).length, 0);
    assert.equal((await keyed(api, KEYS.acme, "k".repeat(128))).status, 201);
    assert.equal((await keyed(api, KEYS.acme, "A_b.c:d-9")).status, 201);
  });

  it("answers a key's replay past tasksPerDay, and records nothing for a create it refused", async () => {
    clock = new Date();
    const api = await service(undefined, { tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0, quotas: { tasksPerDay: 1 } }] });
    const first = await keyed(api, KEYS.acme, "first");
    assert.equal(first.status, 201);
    // The tenant is at its quota, and the retry of the task it was given is still answered.
    const again = await keyed(api, KEYS.acme, "first");
    assert.deepEqual([again.status, again.body.id], [200, first.body.id]);
    for (let i = 0; i < 2; i++) {
      const refused = await keyed(api, KEYS.acme, "second");
      assert.deepEqual([refused.status, refused.body.quota], [429, "tasksPerDay"]);
    }
    assert.deepEqual((await sql(api.database, "SELECT key FROM idempotency")).map((row) => row.key), ["first"]);
    // The refused key is free the next day.
    clock = nextDay(clock);
    assert.equal((await keyed(api, KEYS.acme, "second")).status, 201);
  });

  it("holds a key for 24 hours from the create that made its task, then lets it make another", async () => {
    clock = new Date("2026-03-01T10:00:00Z");
    const api = await service(undefined, idle);
    const first = await keyed(api, KEYS.acme, "K");
    clock = new Date(clock.getTime() + 24 * 3600_000 - 1000);
    assert.deepEqual([(await keyed(api, KEYS.acme, "K")).status, (await keyed(api, KEYS.acme, "K")).body.id], [200, first.body.id]);
    clock = new Date(clock.getTime() + 2000);
    const second = await keyed(api, KEYS.acme, "K");
    assert.equal(second.status, 201);
    assert.notEqual(second.body.id, first.body.id);
    assert.deepEqual((await sql(api.database, "SELECT task FROM idempotency WHERE key = ?", ["K"])).map((row) => row.task), [second.body.id]);
    // From then, the key is the second task's.
    assert.deepEqual([(await keyed(api, KEYS.acme, "K")).status, (await keyed(api, KEYS.acme, "K")).body.id], [200, second.body.id]);
  });

  it("makes one task of concurrent creates with one key, across two replicas on one database", async () => {
    const config = { database: await database(), ...idle };
    const [one, two] = [await service(undefined, config), await service(undefined, config)];
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => keyed(i % 2 ? one : two, KEYS.acme, "once")));
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [...Array(9).fill(200), 201]);
    assert.equal(new Set(answers.map((answer) => answer.body.id)).size, 1);
    assert.equal((await one.store.tasks("acme")).length, 1);
  });

  it("answers a replay with the task's status now, and frees a key whose task's row is gone", async () => {
    const api = await service(undefined);
    const first = await keyed(api, KEYS.acme, "ran");
    await until(async () => (await call(api, KEYS.acme, "GET", `/v1/tasks/${first.body.id}`)).body.ended, "the task to end");
    const again = await keyed(api, KEYS.acme, "ran");
    assert.deepEqual([again.status, again.body], [200, { id: first.body.id, status: "succeeded" }]);

    // As an operator's cleanup would leave it: the key points at no task, so it makes a new one.
    for (const table of ["usage", "events", "approvals"]) await sql(api.database, `DELETE FROM ${table} WHERE task = ?`, [first.body.id]);
    await sql(api.database, "DELETE FROM tasks WHERE id = ?", [first.body.id]);
    const second = await keyed(api, KEYS.acme, "ran");
    assert.equal(second.status, 201);
    assert.deepEqual((await sql(api.database, "SELECT task FROM idempotency")).map((row) => row.task), [second.body.id]);
  });

  it("counts a deleted task toward tasksPerDay still, and keeps it in the usage reports and the day's spending", async () => {
    clock = new Date();
    const api = await service({ tasksPerDay: 2 });
    const ids = [await ran(api, KEYS.acme), await ran(api, KEYS.acme)];
    const usage = async () => (await call(api, KEYS.acme, "GET", "/v1/usage?group=day,model")).body;
    const before = await usage();
    assert.deepEqual([before.total.tasks, before.total.costUsd], [2, 0.004]);
    for (const id of ids) assert.equal((await call(api, KEYS.acme, "DELETE", `/v1/tasks/${id}`)).status, 200);
    assert.deepEqual(await usage(), before);
    const refused = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.deepEqual([refused.status, refused.body.quota, refused.body.used], [429, "tasksPerDay", 2]);

    // What a deleted task spent still stands against usdPerDay.
    const spent = await service({ usdPerDay: 0.002 });
    const id = await ran(spent, KEYS.acme);
    assert.equal((await call(spent, KEYS.acme, "DELETE", `/v1/tasks/${id}`)).status, 200);
    const over = await call(spent, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.deepEqual([over.status, over.body.quota, over.body.used], [429, "usdPerDay", 0.002]);
  });
};

for (const { name, skip } of BACKENDS) {
  describe(`quotas and usage (${name})`, { skip: skip || sandboxProblem() }, () => {
    beforeEach(() => {
      backend = name;
      clock = undefined;
    });
    quotaTests();
  });
}

describe("the quotas' config", () => {
  const base = { database: ":memory:", dataDir: "data", gatewayBaseUrl: "http://127.0.0.1:9/anthropic" } satisfies Partial<Config>;
  const problem = (quotas: unknown, config: object = {}) => {
    try {
      checkConfig({ ...base, tenants: [{ id: "acme", keys: [], quotas }], ...config } as Config);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("is refused with what is wrong", () => {
    assert.equal(problem({ tasksPerDay: 100, usdPerDay: 5, usdPerMonth: 100.5 }), undefined);
    assert.equal(problem(undefined), undefined);
    assert.equal(problem(5), "The config's tenants[0].quotas must be an object, {tasksPerDay, usdPerDay, usdPerMonth}");
    assert.equal(problem({ tasksPerDay: 1.5 }), "The config's tenants[0].quotas.tasksPerDay must be a whole number from 1 up, not 1.5");
    assert.equal(problem({ tasksPerDay: 0 }), "The config's tenants[0].quotas.tasksPerDay must be a whole number from 1 up, not 0");
    assert.equal(problem({ usdPerDay: 0 }), "The config's tenants[0].quotas.usdPerDay must be a number over 0, not 0");
    assert.equal(problem({ usdPerMonth: "10" }), 'The config\'s tenants[0].quotas.usdPerMonth must be a number over 0, not "10"');
    assert.equal(problem({ usdPerWeek: 1 }), "The config's tenants[0].quotas.usdPerWeek isn't a quota: tasksPerDay, usdPerDay or usdPerMonth");
    assert.equal(problem(undefined, { adminKeyEnv: "" }), "The config's adminKeyEnv must be a string that isn't empty");
  });
});
