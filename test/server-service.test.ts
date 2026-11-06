import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { bracketHost, checkConfig, type Config, resolvePaths, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { PgError } from "../server/pg.ts";
import { type RunHandle, type Runner, statusFor } from "../server/runner.ts";
import { LocalRunner } from "../server/runners/local.ts";
import { outcomeOf, Scheduler } from "../server/scheduler.ts";
import { serviceMetrics } from "../server/service-metrics.ts";
import { openStore, type Store, type Task, type Tenant } from "../server/store.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The task service (server/): its API, its store, the fair scheduler and the local runner, with a fake jig
// (fixtures/fake-jig.mjs) that writes events in the event contract's shape. No model is called. Each test
// runs on both stores: SQLite, and Postgres where JIG_TEST_POSTGRES_URL names one.

const FAKE_JIG = join(import.meta.dirname, "fixtures", "fake-jig.mjs");
const SECRET = "the gateway's secret";
const KEYS = { acme: "acme-key", globex: "globex-key" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const services: Service[] = [];
/**
 * What a test opened that keeps the process going (a store's connections, a scheduler's timer), closed
 * after it, newest first, even when it failed: a test file that never exits hangs the run instead of
 * failing it. Each is given a few seconds, as a failed test may leave a run that never ends.
 */
const opened: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) {
    await Promise.race([close().catch(() => {}), new Promise((done) => setTimeout(done, 5000).unref())]);
  }
  await Promise.all(services.splice(0).map((service) => service.close()));
  await removeTempDirs();
  await dropPostgresDatabases();
});

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;
/** The store the tests in the describe being run use. */
let backend: (typeof BACKENDS)[number]["name"] = "SQLite";

/** A new database of the backend's: a file in `base`, or a schema in the test Postgres. */
async function database(base: string): Promise<string> {
  return backend === "SQLite" ? join(base, "jig.db") : postgresDatabase();
}

/** A new store of the backend's, empty. */
async function newStore(): Promise<Store> {
  const store = await openStore(backend === "SQLite" ? ":memory:" : await postgresDatabase());
  let open = true;
  const close = store.close.bind(store);
  store.close = async () => {
    if (open) await close();
    open = false;
  };
  opened.push(() => store.close());
  return store;
}

/** A scheduler on the store, closed after the test (newStore's store after it). */
function newScheduler(...args: ConstructorParameters<typeof Scheduler>): Scheduler {
  const scheduler = new Scheduler(...args);
  opened.push(() => scheduler.close());
  return scheduler;
}

/**
 * A service on a port of its own, with the fake jig, two tenants and a database in a new folder (a new
 * schema, on Postgres). It keeps each task's folder, which the tests look in.
 */
async function service(config: Partial<Config> = {}, base?: string): Promise<Service & { dataDir: string }> {
  base ??= await tempDir("jig-service-");
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
      tenants: [
        { id: "acme", keys: [sha256(KEYS.acme)], budgetUsd: 2.5 },
        { id: "globex", keys: [sha256(KEYS.globex)] },
      ],
      ...config,
    },
    { secret: SECRET },
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

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const statusOf = async (service: Service, id: string, status: string) =>
  until(async () => {
    const { body } = await call(service, KEYS.acme, "GET", `/v1/tasks/${id}`);
    return body.status === status && body;
  }, `task ${id} to be ${status}`);

interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/** A task's server-sent events, frame by frame, as they arrive. */
async function* sse(service: Service, path: string, headers: Record<string, string> = {}): AsyncGenerator<Frame> {
  const res = await fetch(service.url + path, { headers: { authorization: `Bearer ${KEYS.acme}`, ...headers } });
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
      const frame: Frame = { data: "" };
      for (const line of buffer.slice(0, end).split("\n")) {
        const [, field, value] = /^([^:]*): ?(.*)$/.exec(line) ?? [];
        if (field === "id" || field === "event" || field === "data") frame[field] = value;
      }
      if (frame.data) yield frame;
    }
  }
}

async function collect(frames: AsyncGenerator<Frame>): Promise<Frame[]> {
  const all: Frame[] = [];
  for await (const frame of frames) all.push(frame);
  return all;
}

const work = (service: { dataDir: string }, id: string) => join(service.dataDir, "tasks", id, "work");
const record = async (service: { dataDir: string }, id: string) =>
  until(async () => JSON.parse(await readFile(join(work(service, id), ".fake-jig.json"), "utf8").catch(() => "null")), "the fake jig's record");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The tests of the task service's API, which run on each store. */
const apiTests = (name: (typeof BACKENDS)[number]["name"]) => {
  it("needs a tenant's key, and shows a tenant only its own tasks", async () => {
    const api = await service();
    assert.equal((await call(api, undefined, "GET", "/v1/tasks")).status, 401);
    assert.equal((await call(api, "not-a-key", "GET", "/v1/tasks")).status, 401);
    const created = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "wait" });
    assert.equal(created.status, 201);
    const id = created.body.id;
    for (const [method, path] of [["GET", `/v1/tasks/${id}`], ["POST", `/v1/tasks/${id}/cancel`], ["GET", `/v1/tasks/${id}/events`]]) {
      const { status, body } = await call(api, KEYS.globex, method, path);
      assert.equal(status, 404, `${method} ${path}`);
      assert.deepEqual(body, { error: "No such task" });
    }
    assert.deepEqual((await call(api, KEYS.globex, "GET", "/v1/tasks")).body, { tasks: [] });
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/tasks")).body.tasks.map((task: Task) => task.id), [id]);
    await statusOf(api, id, "running");
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks?status=queued")).body.tasks.length, 0);
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks?status=running")).body.tasks.length, 1);
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks?status=lost")).status, 400);
  });

  it("runs a task from queued to succeeded, storing its events in order and streaming them as they come", async () => {
    const api = await service();
    const created = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "wait, then finish", workspace: { files: { "README.md": "hello\n", "src/app.py": "print(1)\n" } }, model: "claude-haiku-4-5" });
    assert.deepEqual(created.body, { id: created.body.id, status: "queued" });
    const id = created.body.id;

    // The first events arrive while the run is still going (the fake jig waits for go).
    const frames = sse(api, `/v1/tasks/${id}/events`);
    const live: Frame[] = [];
    for await (const frame of frames) {
      live.push(frame);
      if (JSON.parse(frame.data).type === "step") break;
    }
    assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks/${id}`)).body.status, "running");
    assert.equal(await readFile(join(work(api, id), "src", "app.py"), "utf8"), "print(1)\n");
    await writeFile(join(work(api, id), "go"), "");
    const rest = await collect(sse(api, `/v1/tasks/${id}/events`, { "last-event-id": live.at(-1)!.id! }));
    const all = [...live, ...rest];
    assert.deepEqual(all.at(-1), { event: "done", data: JSON.stringify({ status: "succeeded" }) });
    const events = all.slice(0, -1).map((frame) => ({ frameId: frame.id, ...JSON.parse(frame.data) }));
    assert.deepEqual(events.map((event) => event.type), ["start", "tool_call", "tool_result", "step", "text", "step", "end"]);
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(events.map((event) => event.frameId), ["1", "2", "3", "4", "5", "6", "7"]);
    assert.equal(events[0].task, "wait, then finish");

    // Stored as jig wrote them, in order.
    const written = (await readFile(join(api.dataDir, "tasks", id, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), written);
    const task = (await call(api, KEYS.acme, "GET", `/v1/tasks/${id}`)).body;
    assert.equal(task.status, "succeeded");
    assert.equal(task.exitCode, 0);
    assert.equal(task.stop, "end_turn");
    assert.deepEqual(task.usage, { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 });
    assert.equal(task.cost, 0.002);
    assert.deepEqual(task.stats, { stop: "end_turn", steps: 2 });
    assert.ok(task.started && task.ended && task.created <= task.started && task.started <= task.ended);

    // A finished task's stream replays only what came after, then ends.
    const resumed = await collect(sse(api, `/v1/tasks/${id}/events`, { "last-event-id": "4" }));
    assert.deepEqual(resumed.map((frame) => frame.id ?? frame.event), ["5", "6", "7", "done"]);
    assert.deepEqual((await collect(sse(api, `/v1/tasks/${id}/events?after=6`))).map((frame) => frame.id ?? frame.event), ["7", "done"]);
  });

  it("cancels a running task, killing everything it started, and a queued one at once", async () => {
    const api = await service({ tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 1 }] });
    const running = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    const queued = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "hang too" })).body.id;
    const { pid, child } = await record(api, running);
    assert.ok(alive(pid) && alive(child));
    assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks/${queued}`)).body.status, "queued");

    assert.deepEqual(await call(api, KEYS.acme, "POST", `/v1/tasks/${queued}/cancel`), { status: 200, body: { id: queued, status: "cancelled" } });
    assert.deepEqual(await call(api, KEYS.acme, "POST", `/v1/tasks/${running}/cancel`), { status: 202, body: { id: running, status: "running" } });
    const task = await statusOf(api, running, "cancelled");
    assert.equal(task.error, null);
    // jig, stopped, writes no end event: the stop says it was interrupted, not that it failed.
    assert.equal(task.stop, "interrupted");
    await until(() => !alive(pid) && !alive(child), "the fake jig and its child to be gone");
    assert.equal((await call(api, KEYS.acme, "POST", `/v1/tasks/${running}/cancel`)).status, 409);
    // The cancelled queued task never ran.
    assert.equal(existsSync(work(api, queued)), false);
  });

  it("stops a run that goes past its time limit and the grace", async () => {
    const api = await service({ graceSeconds: 0 });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "hang", timeLimit: 1 })).body.id;
    const { pid, child } = await record(api, id);
    const task = await statusOf(api, id, "stopped");
    assert.equal(task.stop, "time_limit");
    await until(() => !alive(pid) && !alive(child), "the fake jig and its child to be gone");
  });

  it("kills what a run left behind when jig exits", async () => {
    const api = await service();
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "leave" })).body.id;
    await statusOf(api, id, "succeeded");
    const { child } = await record(api, id);
    try {
      await until(() => !alive(child), "the child jig left, which ignores SIGTERM, to be gone");
    } finally {
      if (alive(child)) process.kill(child, "SIGKILL");
    }
  });

  it("claims nothing once it is closing: a task posted while the runner closes stays queued", async () => {
    const base = await tempDir("jig-service-");
    const db = await database(base);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const runner = Object.assign(new FakeRunner(), { close: () => gate });
    const api = await startService(
      { port: 0, internal: { port: 0 }, database: db, dataDir: join(base, "data"), gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [{ id: "acme", keys: [sha256(KEYS.acme)] }] },
      { secret: SECRET, runner },
    );
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= api.close());
    // Closed after the test even if it fails, with the runner's close let through.
    services.push({ ...api, close: () => (release(), close()) });
    // The runner's close takes a while (a pool's containers being removed), and the API is still up.
    void close();
    const { status, body } = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(status, 201);
    await api.scheduler.settled();
    assert.deepEqual(runner.started, []);
    release();
    await close();
    const after = await openStore(db);
    try {
      assert.equal((await after.task(body.id))!.status, "queued");
    } finally {
      await after.close();
    }
  });

  it("maps jig's exit codes to statuses", async () => {
    const api = await service({ tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 6 }], concurrency: 6 });
    const expected = { 0: ["succeeded", "end_turn"], 1: ["error", "error"], 2: ["stopped", "max_steps"], 4: ["failed", "refusal"], 5: ["failed", "unapproved"], 7: ["stopped", "time_limit"] };
    const ids = new Map<string, string>();
    for (const code of Object.keys(expected)) ids.set(code, (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: `exit ${code}` })).body.id);
    for (const [code, [status, stop]] of Object.entries(expected)) {
      const task = await until(async () => {
        const { body } = await call(api, KEYS.acme, "GET", `/v1/tasks/${ids.get(code)}`);
        return body.ended && body;
      }, `exit ${code}`);
      assert.deepEqual([task.exitCode, task.status, task.stop], [Number(code), status, stop]);
      assert.equal(task.error, status === "error" ? "jig exited with 1: fake jig: stopped with 1" : null);
    }

    // Every code, and the runner's own reasons.
    const table = [0, 1, 2, 3, 4, 5, 6, 7, 8, 130, 143, null].map((exitCode) => [exitCode, statusFor({ exitCode })]);
    assert.deepEqual(table, [[0, "succeeded"], [1, "error"], [2, "stopped"], [3, "stopped"], [4, "failed"], [5, "failed"], [6, "stopped"], [7, "stopped"], [8, "stopped"], [130, "stopped"], [143, "error"], [null, "error"]]);
    assert.equal(statusFor({ exitCode: null, timedOut: true }), "stopped");
    assert.equal(statusFor({ exitCode: 0, cancelled: true }), "cancelled");
  });

  it("refuses requests it can't run, workspace paths that lead out of it among them", async () => {
    const api = await service({ maxBodyBytes: 10_000 });
    const refused = async (body: unknown) => {
      const { status, body: answer } = await call(api, KEYS.acme, "POST", "/v1/tasks", body);
      assert.equal(status, 400, JSON.stringify(body));
      return answer.error as string;
    };
    for (const path of ["../escape", "a/../../escape", "/etc/passwd", "C:/x", "..", "dir/", ""]) {
      assert.match(await refused({ prompt: "hi", workspace: { files: { [path]: "x" } } }), /^workspace\.files: /);
    }
    assert.match(await refused({ prompt: "" }), /prompt/);
    assert.match(await refused({ prompt: "hi", maxSteps: 51 }), /maxSteps must be a whole number from 1 to 50/);
    assert.match(await refused({ prompt: "hi", model: "gpt-5" }), /Claude or DeepSeek/);
    assert.match(await refused({ prompt: "hi", promt: "typo" }), /Unknown field: promt/);
    assert.match(await refused({ prompt: "hi", workspace: { git: "--upload-pack=touch /tmp/x" } }), /workspace\.git/);
    assert.match(await refused("{"), /isn't JSON/);
    // Postgres text can't hold a NUL: it is refused on both stores, not stored on one and a 500 on the other.
    assert.match(await refused({ prompt: "hi\u0000there" }), /NUL/);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "x".repeat(20_000) })).status, 413);
    assert.deepEqual((await call(api, KEYS.acme, "GET", "/v1/tasks")).body, { tasks: [] });

    // The runner refuses them too, for a task that didn't come through the API.
    const base = await tempDir("jig-service-");
    const runner = new LocalRunner({ dataDir: base, jig: [process.execPath, FAKE_JIG], gatewayBaseUrl: "http://127.0.0.1:9", gatewaySecret: SECRET, graceSeconds: 0 });
    const task = { id: "task_1", spec: { prompt: "hi", maxSteps: 1, timeLimit: 1, model: "claude-haiku-4-5", workspace: { files: { "../../escape": "x" } } } } as unknown as Task;
    await assert.rejects(runner.start(task, { id: "acme", limits: { concurrency: 1, maxSteps: 1, timeLimit: 1, budgetUsd: null } }), /leads out of the workspace/);
    assert.equal(existsSync(join(base, "escape")), false);
  });

  it("gives the run a token the gateway's rule accepts, and none of the service's own secrets", async () => {
    const saved = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "a provider's real token";
    try {
      const api = await service();
      const before = Math.floor(Date.now() / 1000);
      const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "the task, on stdin", model: "claude-haiku-4-5", timeLimit: 600 })).body.id;
      await statusOf(api, id, "succeeded");
      const { args, env, task } = await record(api, id);
      assert.equal(task, "the task, on stdin");
      assert.ok(!args.includes("the task, on stdin"), "the task stays out of the process list");
      assert.deepEqual(args.slice(0, 4), ["--yes", "--model", "claude-haiku-4-5", "--base-url"]);
      assert.equal(args[4], "http://127.0.0.1:9/anthropic");
      assert.equal(args.at(-1), "-");

      // The token contract's check, written out here as the gateway does it.
      const token: string = env.ANTHROPIC_API_KEY;
      const [, body, mac] = /^(jgt1\.[\w-]+)\.([\w-]+)$/.exec(token) ?? [];
      const expected = createHmac("sha256", SECRET).update(body).digest();
      assert.ok(timingSafeEqual(Buffer.from(mac, "base64url"), expected));
      const payload = JSON.parse(Buffer.from(body.slice("jgt1.".length), "base64url").toString());
      assert.deepEqual(Object.keys(payload).sort(), ["budgetUsd", "exp", "task", "tenant"]);
      assert.equal(payload.tenant, "acme");
      assert.equal(payload.task, id);
      assert.equal(payload.budgetUsd, 2.5);
      assert.ok(payload.exp >= before + 600 + 5 && payload.exp <= before + 600 + 5 + 120, `exp ${payload.exp - before}s from now`);
      assert.ok(!timingSafeEqual(createHmac("sha256", "another secret").update(body).digest(), expected));

      for (const name of ["ANTHROPIC_AUTH_TOKEN", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "JIG_GATEWAY_SECRET"]) assert.equal(env[name], undefined, name);
      assert.ok(!Object.values(env).includes(SECRET));
      assert.equal(env.JIG_HOME, join(api.dataDir, "tasks", id, "home", ".jig"));
      // A temp folder of the task's own, not the service's, where jig keeps long outputs (see runners/local.ts).
      assert.equal(env.TMPDIR, join(api.dataDir, "tasks", id, "home", "tmp"));
      // git looks for a repository no higher than the task's folder, not in one dataDir lies in.
      assert.equal(env.GIT_CEILING_DIRECTORIES, join(api.dataDir, "tasks", id));
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = saved;
    }
  });

  it("ends the tasks a crashed service left running when it starts again, and runs those still queued", async () => {
    const base = await tempDir("jig-service-");
    const db = await database(base);
    // The crash: a run claimed, its lease left to run out, and a task still queued.
    const store = await openStore(db);
    await store.putTenant({ id: "acme", limits: { concurrency: 2, maxSteps: 50, timeLimit: 60, budgetUsd: null } }, [sha256(KEYS.acme)]);
    const left = await store.createTask("acme", { prompt: "hang", maxSteps: 50, timeLimit: 60, model: "deepseek-flash" });
    const queued = await store.createTask("acme", { prompt: "exit 0", maxSteps: 50, timeLimit: 60, model: "deepseek-flash" });
    const claimed = await store.claim("acme", { owner: "the crashed replica", leaseMs: 100, concurrency: 4, tenantConcurrency: 2 });
    assert.equal(typeof claimed === "object" && claimed.id, left.id);
    await store.close();
    await new Promise((done) => setTimeout(done, 150));

    const api = await service({ database: db }, base);
    const task = (await call(api, KEYS.acme, "GET", `/v1/tasks/${left.id}`)).body;
    assert.equal(task.status, "error");
    assert.match(task.error, /the task service stopped while it ran/);
    assert.ok(task.ended);
    await statusOf(api, queued.id, "succeeded");
  });

  it("shuts out a tenant taken out of the config: its key stops working and its queued tasks never run", async () => {
    const base = await tempDir("jig-service-");
    const db = await database(base);
    // globex may run none at once, so its task is still queued when the service stops.
    const first = await service({ database: db, tenants: [{ id: "acme", keys: [sha256(KEYS.acme)] }, { id: "globex", keys: [sha256(KEYS.globex)], concurrency: 0 }] }, base);
    const id = (await call(first, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    services.splice(services.indexOf(first), 1);
    await first.close();

    const api = await service({ database: db, tenants: [{ id: "acme", keys: [sha256(KEYS.acme)] }] }, base);
    assert.equal((await call(api, KEYS.globex, "GET", "/v1/tasks")).status, 401);
    assert.equal((await call(api, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 401);
    const task = (await api.store.task(id))!;
    assert.deepEqual([task.status, task.error], ["cancelled", "its tenant was removed from the config"]);
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks")).status, 200);
    await api.scheduler.settled();
    assert.equal(existsSync(work(api, id)), false);
  });

  it("refuses a task past the tenant's queue limit", async () => {
    const api = await service({ tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0, maxQueued: 2 }] });
    for (let i = 0; i < 2; i++) assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
    const { status, body } = await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(status, 429);
    assert.match(body.error, /2 tasks queued/);
    assert.equal((await call(api, KEYS.acme, "GET", "/v1/tasks?status=queued")).body.tasks.length, 2);
  });

  it("makes the database's folder, and names the database when it can't open it", { skip: name !== "SQLite" && "SQLite's own" }, async () => {
    const base = await tempDir("jig-service-");
    const api = await service({ database: join(base, "not", "made", "jig.db") }, base);
    assert.equal((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 201);
    assert.ok(existsSync(join(base, "not", "made", "jig.db")));
    await writeFile(join(base, "a-file"), "");
    const path = join(base, "a-file", "jig.db");
    await assert.rejects(openStore(path), (err: Error) => err.message.startsWith(`Couldn't open the database ${path}: `));
  });

  it("lists a tenant's tasks a page at a time, newest first, without their prompts unless asked", async () => {
    const api = await service({ tenants: [{ id: "acme", keys: [sha256(KEYS.acme)], concurrency: 0 }, { id: "globex", keys: [sha256(KEYS.globex)] }] });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.unshift((await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: `task ${i}` })).body.id);
    const first = (await call(api, KEYS.acme, "GET", "/v1/tasks?limit=2")).body;
    assert.deepEqual(first.tasks.map((task: Task) => task.id), ids.slice(0, 2));
    assert.equal(first.next, ids[1]);
    assert.ok(first.tasks.every((task: object) => !("prompt" in task)));
    const second = (await call(api, KEYS.acme, "GET", `/v1/tasks?limit=2&before=${first.next}`)).body;
    assert.deepEqual([second.tasks.map((task: Task) => task.id), second.next], [ids.slice(2, 4), ids[3]]);
    const last = (await call(api, KEYS.acme, "GET", `/v1/tasks?limit=2&before=${second.next}&full=1`)).body;
    assert.deepEqual(last, { tasks: [{ ...last.tasks[0], id: ids[4], prompt: "task 0" }] });
    assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks?before=${ids[0]}`)).body.tasks.length, 4);
    // Another tenant's task leads nowhere, and a page is 1 to 100 tasks.
    assert.deepEqual((await call(api, KEYS.globex, "GET", `/v1/tasks?before=${ids[0]}`)).body, { tasks: [] });
    for (const query of ["limit=0", "limit=101", "limit=x", "before=../x"]) assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks?${query}`)).status, 400, query);
    assert.equal((await call(api, KEYS.acme, "GET", `/v1/tasks/${ids[0]}`)).body.prompt, "task 4");
  });

  it("stores a run's events up to maxEvents, then one notice and its end, and the run goes on", async () => {
    const api = await service({ maxEvents: 3 });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    const frames = await collect(sse(api, `/v1/tasks/${id}/events`));
    assert.deepEqual(frames.map((frame) => frame.id ?? frame.event), ["1", "2", "3", "4", "7", "done"]);
    const stored = (await api.store.events(id)).map(({ seq, event }) => [seq, (event as { type: string }).type]);
    assert.deepEqual(stored, [[1, "start"], [2, "tool_call"], [3, "tool_result"], [4, "notice"], [7, "end"]]);
    assert.match(JSON.parse(frames[3].data).text, /past 3 aren't kept/);
    const task = await statusOf(api, id, "succeeded");
    assert.deepEqual(task.usage, { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 });
  });

  it("stores a run's events up to maxEventBytes, then one notice and its end", async () => {
    // The first event is past it already.
    const api = await service({ maxEventBytes: 10 });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    await statusOf(api, id, "succeeded");
    const stored = (await api.store.events(id)).map(({ seq, event }) => [seq, (event as { type: string }).type]);
    assert.deepEqual(stored, [[1, "notice"], [7, "end"]]);
  });

  it("removes a task's folder once it has ended, unless keepTaskDirs", async () => {
    const api = await service({ keepTaskDirs: false });
    const id = (await call(api, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    await until(() => existsSync(join(api.dataDir, "tasks", id)), "the task's folder");
    await statusOf(api, id, "succeeded");
    await api.scheduler.settled();
    assert.equal(existsSync(join(api.dataDir, "tasks", id)), false);
    assert.equal((await api.store.events(id)).length, 7);
  });
};

for (const { name, skip } of BACKENDS) {
  describe(`the task service's API (${name})`, { skip }, () => {
    beforeEach(() => void (backend = name));
    apiTests(name);
  });
}

/** A runner whose runs end when the test says, recording how many run at once. */
class FakeRunner implements Runner {
  active = new Map<string, { tenant: string; end: () => void }>();
  started: string[] = [];
  most = { all: 0, byTenant: {} as Record<string, number> };

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    let end!: () => void;
    const ended = new Promise<void>((done) => (end = done));
    this.active.set(task.id, { tenant: tenant.id, end });
    this.started.push(tenant.id);
    this.most.all = Math.max(this.most.all, this.active.size);
    const mine = [...this.active.values()].filter((run) => run.tenant === tenant.id).length;
    this.most.byTenant[tenant.id] = Math.max(this.most.byTenant[tenant.id] ?? 0, mine);
    return {
      events: (async function* () {})(),
      wait: async () => {
        await ended;
        this.active.delete(task.id);
        return { exitCode: 0, timedOut: false };
      },
      cancel: end,
    };
  }
}

/**
 * The store, but for `method`, which throws `error` whenever `fails` says so (at once, or once it settles)
 * of its second argument (an event's seq).
 */
function failingStore(store: Store, method: keyof Store, fails: (second: unknown) => boolean | Promise<boolean>, error = () => new Error("the database went away")): Store {
  return new Proxy(store, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver);
      if (name !== method) return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        if (await fails(args[1])) throw error();
        return value.apply(target, args);
      };
    },
  });
}

/** A runner whose runs write two notices and an end that spent `cost`, and exit 0. */
function endsWith(cost: number): Runner {
  return {
    async start() {
      return {
        events: (async function* () {
          for (let seq = 1; seq <= 2; seq++) yield { v: 1, seq, ts: new Date().toISOString(), type: "notice", text: `notice ${seq}` };
          yield { v: 1, seq: 3, ts: new Date().toISOString(), type: "end", stop: "end_turn", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 }, cost };
        })(),
        wait: async () => ({ exitCode: 0, timedOut: false }),
        cancel() {},
      };
    },
  };
}

/** The task once it has ended. */
const endOf = (store: Store, id: string) =>
  until(async () => {
    const task = (await store.task(id))!;
    return task.status !== "running" && task.status !== "queued" && task;
  }, `task ${id} to end`);

/** What the usage ledger holds as spent, in all. */
const billed = async (store: Store) => (await store.usage({ from: "2000-01-01", to: "2100-01-01", group: [] })).reduce((sum, row) => sum + row.costUsd, 0);

/** The tests of the scheduler, which run on each store. */
const schedulerTests = () => {
  it("holds the global and each tenant's limit under 50 tasks from 3 tenants, and takes the tenants in turn", async () => {
    const store = await newStore();
    const caps: Record<string, number> = { a: 3, b: 2, c: 1 };
    for (const [id, concurrency] of Object.entries(caps)) await store.putTenant({ id, limits: { concurrency, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const runner = new FakeRunner();
    const scheduler = newScheduler(store, runner, { concurrency: 4 });
    // a queues 30 before b's 15 and c's 5.
    for (const [tenant, count] of [["a", 30], ["b", 15], ["c", 5]] as const) {
      for (let i = 0; i < count; i++) await store.createTask(tenant, { prompt: `${tenant}${i}`, maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    }
    await scheduler.poke();
    await scheduler.settled();
    assert.deepEqual(runner.started, ["a", "b", "c", "a"]);
    while (runner.active.size) {
      // Each tenant's limit holds at every moment.
      const byTenant: Record<string, number> = {};
      for (const run of runner.active.values()) byTenant[run.tenant] = (byTenant[run.tenant] ?? 0) + 1;
      for (const [tenant, count] of Object.entries(byTenant)) assert.ok(count <= caps[tenant], `${tenant}: ${count}`);
      assert.ok(runner.active.size <= 4);
      runner.active.values().next().value!.end();
      await scheduler.settled();
    }
    assert.equal(runner.started.length, 50);
    assert.deepEqual(runner.most, { all: 4, byTenant: { a: 3, b: 2, c: 1 } });
    assert.equal((await store.inStatus("succeeded")).length, 50);
    // c's five didn't wait for a's thirty.
    assert.ok(runner.started.lastIndexOf("c") < runner.started.lastIndexOf("a"));
    await store.close();
  });

  it("stops a run whose events can't be read, and holds its slot until the run has ended", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    for (const prompt of ["a0", "a1"]) await store.createTask("a", { prompt, maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    const started: string[] = [];
    let cancels = 0;
    let end!: () => void;
    const runner: Runner = {
      async start(task) {
        started.push(task.spec.prompt);
        const ended = new Promise<void>((done) => (end = done));
        return {
          // As a reader would that ran out of memory on what a task's commands wrote.
          events: (async function* () {
            throw new RangeError("Invalid string length");
          })(),
          wait: async () => {
            await ended;
            return { exitCode: 137, timedOut: false };
          },
          cancel: () => void cancels++,
        };
      },
    };
    const scheduler = newScheduler(store, runner, { concurrency: 4 });
    await scheduler.poke();
    while (!cancels) await new Promise((done) => setImmediate(done));
    await scheduler.settled();
    // Stopped, but not yet ended: still counted, and a1 waits.
    assert.deepEqual([started, scheduler.running("a")], [["a0"], 1]);
    end();
    await scheduler.settled();
    const [failed] = await store.inStatus("error");
    assert.deepEqual([failed.spec.prompt, failed.error], ["a0", "Invalid string length"]);
    assert.deepEqual(started, ["a0", "a1"]);
    end();
    await scheduler.close();
    await store.close();
  });

  it("reads only the tasks it starts, however many are queued", async () => {
    const store = await newStore();
    for (const id of ["a", "b"]) await store.putTenant({ id, limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    for (let i = 0; i < 5000; i++) await store.createTask("a", { prompt: "x".repeat(1000), maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    await store.createTask("b", { prompt: "b0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // Counts the tasks the store hands the scheduler.
    let read = 0;
    const counted = new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          read += Array.isArray(result) ? result.filter((item) => typeof item === "object" && item && "spec" in item).length : result && typeof result === "object" && "spec" in result ? 1 : 0;
          return result;
        };
      },
    });
    const runner = new FakeRunner();
    const scheduler = newScheduler(counted, runner, { concurrency: 4 });
    await scheduler.poke();
    assert.deepEqual([runner.started, read], [["a", "b"], 2]);
    // a is at its limit and b's queue is empty: another poke starts nothing and reads nothing.
    read = 0;
    await scheduler.poke();
    assert.deepEqual([runner.started.length, read], [2, 0]);
    // Each run that ends lets one more of a's start, read alone.
    runner.active.values().next().value!.end();
    await scheduler.settled();
    assert.equal(read, 1);
    for (const run of runner.active.values()) run.end();
    await scheduler.close();
    await store.close();
  });

  it("stores the outcome of a run whose end and last words hold a NUL", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // A task's commands can write the events file, and jig's last line of output.
    const runner: Runner = {
      async start() {
        return {
          events: (async function* () {
            yield { v: 1, seq: 1, ts: new Date().toISOString(), type: "end", stop: "error\u0000x", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, cost: 0.5 };
          })(),
          wait: async () => ({ exitCode: 1, timedOut: false, message: "jig said: \u0000oops" }),
          cancel() {},
        };
      },
    };
    const scheduler = newScheduler(store, runner, { concurrency: 4 });
    await scheduler.poke();
    // settled() doesn't wait for a run still storing its events, as this one may be on Postgres.
    const ended = await until(async () => {
      const now = (await store.task(task.id))!;
      return now.status !== "running" && now.status !== "queued" && now;
    }, "the run's outcome to be stored");
    assert.deepEqual([ended.status, ended.exitCode, ended.stop, ended.error, ended.cost], ["error", 1, "error\uFFFDx", "jig exited with 1: jig said: \uFFFDoops", 0.5]);
    assert.deepEqual(ended.usage, { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 });
    await scheduler.close();
    await store.close();
  });

  for (const failures of [1, 2]) {
    it(`stores every event of a run whose event write fails ${failures === 1 ? "once" : "twice in a row"}, and bills what it spent`, async () => {
      const store = await newStore();
      await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
      const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
      // The database drops the connection as the second event is written: a blip, not an outage.
      let left = failures;
      const flaky = failingStore(store, "addEvent", (seq) => seq === 2 && left-- > 0);
      const metrics = serviceMetrics();
      const scheduler = newScheduler(flaky, endsWith(1.25), { concurrency: 4, metrics });
      await scheduler.poke();
      const ended = await endOf(store, task.id);
      assert.deepEqual([ended.status, ended.error, ended.cost], ["succeeded", null, 1.25]);
      assert.deepEqual((await store.events(task.id)).map(({ seq }) => seq), [1, 2, 3]);
      assert.equal(await billed(store), 1.25);
      assert.equal(metrics.storeErrors.get(), failures);
      await scheduler.close();
      await store.close();
    });
  }

  it("stores the outcome of a run when its first write fails, and bills what it spent", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    let left = 1;
    const flaky = failingStore(store, "finish", () => left-- > 0);
    // A short lease, so that an outcome given up on would show as the lease's error at once.
    const scheduler = newScheduler(flaky, endsWith(1.25), { concurrency: 4, leaseMs: 1000 });
    await scheduler.start();
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, ended.error, ended.cost], ["succeeded", null, 1.25]);
    assert.equal(await billed(store), 1.25);
    await scheduler.close();
    await store.close();
  });

  it("stores the outcome of a cancelled run when its first write fails, and bills what it spent", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    let left = 1;
    const flaky = failingStore(store, "finish", () => left-- > 0);
    // jig, stopped, writes its end with what it spent so far.
    let stop!: () => void;
    const stopped = new Promise<void>((done) => (stop = done));
    const runner: Runner = {
      async start() {
        return {
          events: (async function* () {
            await stopped;
            yield { v: 1, seq: 1, ts: new Date().toISOString(), type: "end", stop: "interrupted", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 }, cost: 0.75 };
          })(),
          wait: async () => (await stopped, { exitCode: 143, timedOut: false }),
          cancel: () => stop(),
        };
      },
    };
    const scheduler = newScheduler(flaky, runner, { concurrency: 4, leaseMs: 1000 });
    await scheduler.start();
    await until(() => scheduler.running("a"), "the run to start");
    assert.equal(await scheduler.cancel((await store.task(task.id))!), "running");
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, ended.cost], ["cancelled", 0.75]);
    assert.equal(await billed(store), 0.75);
    await scheduler.close();
    await store.close();
  });

  it("tries an outcome again only within half a lease of its first try's start, though that try hangs", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // The first try hangs past half the lease (as a query waits for its timeout), then fails.
    let tries = 0;
    const flaky = failingStore(store, "finish", async () => tries++ === 0 && (await new Promise((done) => setTimeout(done, 600)), true));
    const scheduler = newScheduler(flaky, endsWith(1.25), { concurrency: 4, leaseMs: 1000 });
    await scheduler.start();
    // Given up on, it is left to its lease, which ends it.
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, tries], ["error", 1]);
    await scheduler.close();
    await store.close();
  });

  it("doesn't try again a write the database says is wrong in its data, and ends the run as an error", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    let tries = 0;
    const outOfRange = () => new PgError({ C: "22003", M: "value out of range for type integer" });
    const flaky = failingStore(store, "addEvent", (seq) => seq === 2 && (tries++, true), outOfRange);
    // A long lease: retried, the write would hold the run for half of it.
    const scheduler = newScheduler(flaky, endsWith(1.25), { concurrency: 4, leaseMs: 60_000 });
    const began = Date.now();
    await scheduler.poke();
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, ended.error, tries], ["error", "value out of range for type integer", 1]);
    assert.ok(Date.now() - began < 5000);
    await scheduler.close();
    await store.close();
  });

  it("holds a run's slot while its outcome is tried again", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const ids: string[] = [];
    for (const prompt of ["a0", "a1"]) ids.push((await store.createTask("a", { prompt, maxSteps: 5, timeLimit: 60, model: "deepseek-flash" })).id);
    // The first three tries of the first outcome fail, over 700 ms; when the fourth was begun is kept.
    let tries = 0;
    let stored: number | undefined;
    const flaky = failingStore(store, "finish", () => ++tries <= 3 || ((stored ??= Date.now()), false));
    const started = new Map<string, number>();
    const ends = endsWith(0);
    const runner: Runner = { start: (task, tenant) => (started.set(task.id, Date.now()), ends.start(task, tenant)) };
    const scheduler = newScheduler(flaky, runner, { concurrency: 4, leaseMs: 4000 });
    await scheduler.start();
    await until(() => started.has(ids[1]), "the second run to start");
    assert.ok(stored !== undefined && started.get(ids[1])! >= stored, "the second run started while the first's outcome was tried again");
    for (const id of ids) assert.equal((await endOf(store, id)).status, "succeeded");
    assert.equal(tries, 5);
    await scheduler.close();
    await store.close();
  });

  it("stores a run's events up to maxEventBytes, then one notice and its end", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // As a task's commands can write the events file on Docker and Kubernetes: 200 lines of 512 KiB.
    const text = "x".repeat(512 * 1024);
    const runner: Runner = {
      async start() {
        return {
          events: (async function* () {
            for (let seq = 1; seq <= 200; seq++) yield { v: 1, seq, ts: new Date().toISOString(), type: "notice", text };
            yield { v: 1, seq: 201, ts: new Date().toISOString(), type: "end", stop: "end_turn" };
          })(),
          wait: async () => ({ exitCode: 0, timedOut: false }),
          cancel() {},
        };
      },
    };
    const scheduler = newScheduler(store, runner, { concurrency: 4, maxEventBytes: 8 * 1024 * 1024 });
    await scheduler.poke();
    assert.equal((await endOf(store, task.id)).status, "succeeded");
    const events = await store.events(task.id);
    const [notice, end] = events.slice(-2).map(({ event }) => event as { type: string; text?: string });
    assert.deepEqual([notice.type, end.type], ["notice", "end"]);
    assert.match(notice.text!.slice(0, 200), /past 8388608 bytes aren't kept/);
    const kept = events.slice(0, -2);
    assert.ok(kept.length > 0 && kept.every(({ event }) => (event as { text?: string }).text === text));
    assert.ok(kept.reduce((sum, { event }) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= 8 * 1024 * 1024);
    assert.equal(kept.length, 15);
    await scheduler.close();
    await store.close();
  });

  it("frees a run's slot even when its outcome can't be stored", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    for (const prompt of ["a0", "a1"]) await store.createTask("a", { prompt, maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // The database fails from the first run's outcome on, past every retry.
    const failing = failingStore(store, "finish", () => true);
    const runner = new FakeRunner();
    const lines: string[] = [];
    const scheduler = newScheduler(failing, runner, { concurrency: 4, leaseMs: 300, log: createLog("service", { write: (line) => lines.push(line) }) });
    await scheduler.start();
    await until(() => runner.active.size, "a0 to start");
    runner.active.values().next().value!.end();
    // a0's lease, no longer renewed, runs out: it ends as an error, and a1 takes the slot it had.
    await until(() => runner.started.length === 2, "a1 to start");
    assert.ok(lines.some((line) => line.includes("couldn't store how the task ended")), lines.join("\n"));
    const [lost] = await store.inStatus("error");
    assert.equal(lost.spec.prompt, "a0");
    assert.match(lost.error!, /stopped renewing its lease/);
    assert.equal(scheduler.running("a"), 1);
    for (const run of runner.active.values()) run.end();
    await scheduler.close();
    await store.close();
  });

  it("stops a run whose claim was in flight as it closed, before it says it has closed", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // The claim waits for the gate, as one on a slow database would.
    let claiming = false;
    let open!: () => void;
    const gate = new Promise<void>((done) => (open = done));
    const slow = new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (name !== "claim") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          claiming = true;
          await gate;
          return value.apply(target, args);
        };
      },
    });
    const runner = new FakeRunner();
    const scheduler = newScheduler(slow, runner, { concurrency: 4 });
    void scheduler.poke();
    await until(() => claiming, "the claim");
    const closed = scheduler.close();
    open();
    await closed;
    assert.equal(scheduler.running(), 0);
    // It started, was stopped, and ended as the service's stop.
    assert.deepEqual([runner.started, runner.active.size], [["a"], 0]);
    const ended = (await store.task(task.id))!;
    assert.deepEqual([ended.status, ended.error], ["error", "the task service stopped while it ran"]);
    await store.close();
  });

  it("counts a task only on the replica that ended it", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const task = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    // Replica A can't renew its lease (it lost the database), and its run ends only once B has ended the task.
    const cut = new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (name === "renew") return async () => Promise.reject(new Error("the database went away"));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let release!: () => void;
    const released = new Promise<void>((done) => (release = done));
    let started = 0;
    const runner: Runner = {
      async start() {
        started++;
        return {
          events: (async function* () {
            await released;
            yield { v: 1, seq: 1, ts: new Date().toISOString(), type: "end", stop: "end_turn", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, cost: 0.5 };
          })(),
          wait: async () => ({ exitCode: 0, timedOut: false }),
          cancel: () => release(),
        };
      },
    };
    const quiet = createLog("service", { write: () => {} });
    const [mine, theirs] = [serviceMetrics(), serviceMetrics()];
    const a = newScheduler(cut, runner, { concurrency: 4, leaseMs: 300, metrics: mine, log: quiet });
    await a.start();
    await until(() => started, "A's run to start");
    const b = newScheduler(store, new FakeRunner(), { concurrency: 4, leaseMs: 300, metrics: theirs, log: quiet });
    await b.start();
    await until(async () => (await store.task(task.id))!.status === "error", "B to end the task whose lease ran out");
    release();
    await until(() => !a.running(), "A's run to end");
    await a.settled();
    // A's own run ended, but the task was B's to end by then: only B counts it.
    assert.deepEqual([mine.ended.get({ tenant: "a", status: "succeeded" }), mine.ended.get({ tenant: "a", status: "error" })], [0, 0]);
    assert.deepEqual([mine.cost.get({ tenant: "a" }), mine.tokens.get({ tenant: "a", kind: "input" })], [0, 0]);
    assert.equal(theirs.ended.get({ tenant: "a", status: "error" }), 1);
    assert.equal((await store.task(task.id))!.status, "error");
    await a.close();
    await b.close();
    await store.close();
  });

  it("starts even when a task whose lease ran out can't be read again to be counted", async () => {
    const store = await newStore();
    await store.putTenant({ id: "a", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    const left = await store.createTask("a", { prompt: "a0", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" });
    await store.claim("a", { owner: "a crashed replica", leaseMs: 100, concurrency: 4, tenantConcurrency: 1 });
    await new Promise((done) => setTimeout(done, 150));
    const unreadable = new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (name === "task") return async () => Promise.reject(new Error("the database went away"));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const metrics = serviceMetrics();
    const lines: string[] = [];
    const scheduler = newScheduler(unreadable, new FakeRunner(), { concurrency: 4, metrics, log: createLog("service", { write: (line) => lines.push(line) }) });
    assert.deepEqual(await scheduler.start(), [left.id]);
    assert.equal(metrics.storeErrors.get(), 1);
    assert.ok(lines.some((line) => line.includes("couldn't read an expired task to count it")), lines.join("\n"));
    assert.equal((await store.task(left.id))!.status, "error");
    await scheduler.close();
    await store.close();
  });
};

for (const { name, skip } of BACKENDS) {
  describe(`the scheduler (${name})`, { skip }, () => {
    beforeEach(() => void (backend = name));
    schedulerTests();
  });
}

describe("a run's outcome", () => {
  it("has stop interrupted when the run was stopped and left no end event", () => {
    const killed = { exitCode: 143, timedOut: false };
    const cancelled = outcomeOf(killed, undefined, undefined, "cancelled");
    assert.deepEqual([cancelled.status, cancelled.stop, cancelled.error], ["cancelled", "interrupted", null]);
    const shutdown = outcomeOf(killed, undefined, undefined, "shutdown");
    assert.deepEqual([shutdown.status, shutdown.stop, shutdown.error], ["error", "interrupted", "the task service stopped while it ran"]);
    // Its own end event, a time limit and an exit code alone say otherwise.
    assert.equal(outcomeOf(killed, { v: 1, seq: 9, ts: "", type: "end", stop: "max_steps" }, undefined, "cancelled").stop, "max_steps");
    assert.equal(outcomeOf({ exitCode: null, timedOut: true }, undefined, undefined, undefined).stop, "time_limit");
    assert.equal(outcomeOf(killed, undefined, undefined, undefined).stop, "error");
    assert.equal(outcomeOf(undefined, undefined, "the workspace couldn't be made", undefined).stop, null);
  });
});

describe("the service's config", () => {
  const base = { database: ":memory:", dataDir: "data", gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [] } satisfies Config;
  const problem = (config: object) => {
    try {
      checkConfig({ ...base, ...config } as Config);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("is refused with what is wrong, before anything starts", async () => {
    assert.equal(problem({}), undefined);
    assert.equal(problem({ concurrency: 0 }), "The config's concurrency must be a whole number from 1 up, not 0");
    assert.equal(problem({ concurrency: 2.5 }), "The config's concurrency must be a whole number from 1 up, not 2.5");
    assert.equal(problem({ port: 70000 }), "The config's port must be a whole number from 0 to 65535, not 70000");
    assert.equal(problem({ database: undefined }), "The config's database is missing");
    assert.equal(problem({ gatewayBaseUrl: "gateway:8081" }), 'The config\'s gatewayBaseUrl must be an http or https URL, not "gateway:8081"');
    assert.equal(problem({ leaseSeconds: 0 }), "The config's leaseSeconds must be a number over 0, up to 86400, not 0");
    assert.equal(problem({ keepTaskDirs: "yes" }), "The config's keepTaskDirs must be true or false");
    assert.equal(problem({ maxEventBytes: 0 }), "The config's maxEventBytes must be a whole number from 1 up, not 0");
    assert.equal(problem({ tenants: {} }), "The config's tenants must be a list");
    assert.equal(problem({ docker: { image: "w", network: "n", pool: { size: 4, maxIdleSeconds: 300, baseUrl: "http://10.0.0.7:8082" } } }), undefined);
    assert.equal(problem({ docker: { image: "w", network: "n", pool: 4 } }), "The config's docker.pool must be an object, {size, maxIdleSeconds}");
    assert.equal(problem({ kubernetes: { image: "w", pool: { size: -1 } } }), "The config's kubernetes.pool.size must be a whole number from 0 up, not -1");
    assert.equal(problem({ kubernetes: { image: "w", pool: { size: 1, maxIdleSeconds: 0 } } }), "The config's kubernetes.pool.maxIdleSeconds must be a number over 0, not 0");
    const key = sha256(KEYS.acme);
    assert.equal(problem({ tenants: [{ id: "acme", keys: [key] }, { id: "acme", keys: [] }] }), 'The config\'s tenants[1].id "acme" is another tenant\'s too');
    assert.equal(problem({ tenants: [{ id: "acme", keys: [key] }, { id: "globex", keys: [key.toUpperCase()] }] }), "The config's tenants[1].keys[0] is tenant acme's key too: a key opens one tenant");
    assert.equal(problem({ tenants: [{ id: "acme", keys: [key, key] }] }), "The config's tenants[0].keys[1] is there twice");
    assert.match(problem({ tenants: [{ id: "acme", keys: [KEYS.acme] }] })!, /tenants\[0\]\.keys\[0\] must be a key's SHA-256 hash/);
    assert.equal(problem({ tenants: [{ id: "acme", keys: [], concurrency: -1 }] }), "The config's tenants[0].concurrency must be a whole number from 0 up, not -1");
    assert.equal(problem({ tenants: [{ id: "acme", keys: [], budgetUsd: null, maxQueued: 0 }] }), undefined);
    await assert.rejects(startService({ ...base, concurrency: 0 }, { secret: SECRET }), /concurrency must be a whole number from 1 up/);
  });

  it("refuses what could never run: times past a timer's reach, a runner without its settings, a pool past concurrency", () => {
    // jig refuses a --time-limit or --approval-timeout of 24 days, and a timer past 2^31 ms fires at once.
    assert.equal(problem({ tenants: [{ id: "acme", keys: [], timeLimit: 3_000_000 }] }), "The config's tenants[0].timeLimit must be a whole number from 1 to 2000000, not 3000000");
    assert.equal(problem({ tenants: [{ id: "acme", keys: [], approvalTimeout: 3_000_000 }] }), "The config's tenants[0].approvalTimeout must be a whole number from 1 to 2000000, not 3000000");
    assert.equal(problem({ tenants: [{ id: "acme", keys: [], timeLimit: 2_000_000, approvalTimeout: 2_000_000 }], graceSeconds: 86_400, leaseSeconds: 86_400, heartbeatSeconds: 3_600 }), undefined);
    assert.equal(problem({ graceSeconds: 1e6 }), "The config's graceSeconds must be a number over or at 0, up to 86400, not 1000000");
    assert.equal(problem({ leaseSeconds: 1e7 }), "The config's leaseSeconds must be a number over 0, up to 86400, not 10000000");
    assert.equal(problem({ heartbeatSeconds: 1e7 }), "The config's heartbeatSeconds must be a number over 0, up to 3600, not 10000000");
    assert.equal(problem({ runner: "podman" }), 'The config\'s runner must be local, docker or kubernetes, not "podman"');
    assert.equal(problem({ runner: null }), "The config's runner must be local, docker or kubernetes, not null");
    assert.equal(problem({ runner: "docker", docker: { image: "x" } }), "The config's docker.network is missing");
    assert.equal(problem({ runner: "docker" }), "The config's docker.image is missing");
    assert.equal(problem({ runner: "kubernetes", kubernetes: { image: "" } }), "The config's kubernetes.image must be a string that isn't empty");
    assert.equal(problem({ runner: "kubernetes", kubernetes: { image: "w" } }), undefined);
    // A replica never runs more than concurrency at once, so idle workers past it are never used.
    assert.equal(problem({ docker: { image: "w", network: "n", pool: { size: 4000 } } }), "The config's docker.pool.size must be at most concurrency, 4: idle workers past it are never used");
    assert.equal(problem({ concurrency: 8, kubernetes: { image: "w", pool: { size: 8 } } }), undefined);
  });

  it("refuses a bad runner config before it changes the store", async () => {
    const dir = await tempDir("jig-service-");
    const database = join(dir, "jig.db");
    const store = await openStore(database);
    await store.putTenant({ id: "globex", limits: { concurrency: 2, maxSteps: 50, timeLimit: 60, budgetUsd: null } }, [sha256(KEYS.globex)]);
    const queued = await store.createTask("globex", { prompt: "exit 0", maxSteps: 50, timeLimit: 60, model: "deepseek-flash" });
    await store.close();
    // globex has been taken out of the config, but the config can't run: nothing of the store's changes.
    const config = { ...base, port: 0, internal: { port: 0 }, database, dataDir: join(dir, "data"), runner: "docker", docker: { image: "jig-worker" } } as unknown as Config;
    await assert.rejects(startService(config, { secret: SECRET }), /docker\.network is missing/);
    const after = await openStore(database);
    opened.push(() => after.close());
    assert.equal((await after.task(queued.id))!.status, "queued");
  });

  it("brackets an IPv6 pod address in the pool's URL", () => {
    assert.equal(bracketHost("http://fd00::1:8082"), "http://[fd00::1]:8082");
    assert.equal(bracketHost("http://fd00::1:8082/x"), "http://[fd00::1]:8082/x");
    assert.equal(problem({ docker: { image: "w", network: "n", pool: { size: 1, baseUrl: bracketHost("http://fd00::1:8082") } } }), undefined);
    for (const url of ["http://10.0.0.5:8082", "http://[fd00::1]:8082", "http://api:8082"]) assert.equal(bracketHost(url), url);
  });

  it("takes the paths in the config as relative to it", () => {
    const config = { ...base, database: "data/jig.db", dataDir: "data", jig: ["node", "./src/cli.ts", "../jig/cli.ts", "/opt/jig/cli.ts", "--flag"] } as Config;
    resolvePaths(config, "/etc/jig");
    assert.deepEqual([config.database, config.dataDir, config.jig], ["/etc/jig/data/jig.db", "/etc/jig/data", ["node", "/etc/jig/src/cli.ts", "/etc/jig/cli.ts", "/opt/jig/cli.ts", "--flag"]]);
    for (const database of [":memory:", "postgres://jig@db/jig", "postgresql://jig@db/jig"]) {
      const other = { ...base, database } as Config;
      resolvePaths(other, "/etc/jig");
      assert.equal(other.database, database);
    }
  });
});

describe("the service's start", () => {
  /** Two ports that were free a moment ago. */
  const freePorts = async () => {
    const servers = [createServer().listen(0, "127.0.0.1"), createServer().listen(0, "127.0.0.1")];
    await Promise.all(servers.map((server) => once(server, "listening")));
    const ports = servers.map((server) => (server.address() as AddressInfo).port);
    await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
    return ports;
  };
  /** Whether a port can be listened on. */
  const free = async (port: number) => {
    const server = createServer();
    const listening = await new Promise<boolean>((done) => server.once("error", () => done(false)).listen(port, "127.0.0.1", () => done(true)));
    if (listening) await new Promise((done) => server.close(done));
    return listening;
  };

  for (const taken of ["port", "metrics"] as const) {
    it(`claims no task when the ${taken === "port" ? "API's" : "metrics'"} port is taken, and closes what it opened`, async () => {
      const dir = await tempDir("jig-service-");
      const database = join(dir, "jig.db");
      const store = await openStore(database);
      await store.putTenant({ id: "acme", limits: { concurrency: 2, maxSteps: 50, timeLimit: 60, budgetUsd: null } }, [sha256(KEYS.acme)]);
      const queued = await store.createTask("acme", { prompt: "exit 0", maxSteps: 50, timeLimit: 60, model: "deepseek-flash" });
      await store.close();
      const holder = createServer().listen(0, "127.0.0.1");
      await once(holder, "listening");
      opened.push(() => new Promise((done) => holder.close(done)));
      const held = (holder.address() as AddressInfo).port;
      const [internal, api] = await freePorts();
      let closed = 0;
      const runner = Object.assign(new FakeRunner(), { close: async () => void closed++ });
      const config: Config = {
        port: taken === "port" ? held : api,
        internal: { port: internal },
        ...(taken === "metrics" && { metrics: { port: held } }),
        database,
        dataDir: join(dir, "data"),
        gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
        tenants: [{ id: "acme", keys: [sha256(KEYS.acme)] }],
      };
      await assert.rejects(startService(config, { secret: SECRET, runner }), /EADDRINUSE/);
      assert.deepEqual([runner.started, closed], [[], 1]);
      assert.ok(await free(internal), "the internal listener is closed");
      if (taken === "metrics") assert.ok(await free(api), "the API's listener is closed");
      // The store is closed, and the task waits for the next start.
      const after = await openStore(database);
      opened.push(() => after.close());
      assert.equal((await after.task(queued.id))!.status, "queued");
      await after.putTenant({ id: "globex", limits: { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null } }, []);
    });
  }

  it("hides dataDir, the database and the config from the local runner's tasks, and warns of what they still share", async () => {
    const lines: string[] = [];
    const log = createLog("service", { format: "text", write: (line) => lines.push(line) });
    const dir = await tempDir("jig-service-");
    const config: Config = { port: 0, internal: { port: 0 }, database: join(dir, "jig.db"), dataDir: join(dir, "data"), gatewayBaseUrl: "http://127.0.0.1:9/anthropic", jig: [process.execPath, FAKE_JIG], keepTaskDirs: true, tenants: [{ id: "acme", keys: [sha256(KEYS.acme)] }, { id: "globex", keys: [sha256(KEYS.globex)] }] };
    const configFile = join(dir, "service.json");
    await writeFile(configFile, JSON.stringify(config));
    const started = await startService(config, { secret: SECRET, log, configFile });
    services.push(started);
    const warned = (start: RegExp) => assert.ok(lines.some((line) => start.test(line)), lines.join("\n"));
    if (sandboxProblem()) warned(/^jig service: jig has no sandbox here \(.+\), so a local task's commands run directly on this machine/);
    else {
      warned(/^jig service: the local runner keeps tenants apart only by jig's sandbox: a task's commands can't reach the database or the other tasks' folders, but share/);
      // Only where the sandbox lets commands write: /tmp and /var/tmp, not the service's TMPDIR (macOS's is
      // elsewhere), as each task has its own.
      const temps = process.platform === "darwin" ? ["/private/tmp"] : ["/tmp", "/var/tmp"];
      const dataDirWarning = /^jig service: dataDir is in a temp folder, where a local task's commands can write their task's home/;
      if (temps.some((temp) => realpathSync(dir).startsWith(`${temp}/`))) warned(dataDirWarning);
      else assert.ok(!lines.some((line) => dataDirWarning.test(line)), lines.join("\n"));
    }
    // Each task's jig gets user settings that hide them from its commands, but for its project and home.
    const { id } = (await call(started, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body;
    await statusOf(started, id, "succeeded");
    const settings = JSON.parse(await readFile(join(dir, "data", "tasks", id, "home", ".jig", "settings.json"), "utf8"));
    const db = join(dir, "jig.db");
    assert.deepEqual(settings, { hiddenPaths: [join(dir, "data"), db, `${db}-wal`, `${db}-shm`, `${db}-journal`, configFile] });
  });

  it("loads node:sqlite only for a SQLite store, so a service on Postgres gives no warning of it", async () => {
    const api = pathToFileURL(join(import.meta.dirname, "..", "server", "api.ts")).href;
    const { stderr } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(api)})`]);
    assert.doesNotMatch(stderr, /SQLite/);
  });
});
