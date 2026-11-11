import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Config, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { Pool } from "../server/pg.ts";
import { type Leftover, type RunHandle, type Runner, taskFolders } from "../server/runner.ts";
import { DockerRunner } from "../server/runners/docker.ts";
import { LocalRunner } from "../server/runners/local.ts";
import { Scheduler } from "../server/scheduler.ts";
import { serviceMetrics } from "../server/service-metrics.ts";
import { openStore, type Store, type Task, type Tenant } from "../server/store.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// Several replicas of the task service on one database: they keep to the caps together, a task posted to
// one runs on either and is followed and cancelled through the other, and one that crashes has its tasks
// ended by another once their leases run out. On Postgres where JIG_TEST_POSTGRES_URL names one, and on
// SQLite, which several processes on one machine can share too. The fake jig stands in for jig.

const FAKE_JIG = join(import.meta.dirname, "fixtures", "fake-jig.mjs");
const API = join(import.meta.dirname, "..", "server", "api.ts");
const SECRET = "the gateway's secret";
const KEY = "acme-key";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const services: Service[] = [];
const children: ChildProcess[] = [];
const pids: number[] = [];
/** Stores and schedulers a test opened itself, closed after it, the last opened first. */
const opened: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  // What a crashed replica's runs left behind.
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(services.splice(0).map((service) => service.close()));
  await removeTempDirs();
  await dropPostgresDatabases();
});

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;
let backend: (typeof BACKENDS)[number]["name"] = "SQLite";

/** The config two replicas share: one database, a short lease, each its own folder for the tasks. */
async function shared(config: Partial<Config> = {}): Promise<Omit<Config, "dataDir">> {
  const base = await tempDir("jig-replicas-");
  return {
    port: 0,
    internal: { port: 0 },
    database: backend === "SQLite" ? join(base, "jig.db") : await postgresDatabase(),
    gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
    jig: [process.execPath, FAKE_JIG],
    graceSeconds: 5,
    leaseSeconds: 1,
    keepTaskDirs: true,
    tenants: [{ id: "acme", keys: [sha256(KEY)], concurrency: 4 }],
    ...config,
  };
}

async function replica(config: Omit<Config, "dataDir">, runner?: Runner): Promise<Service & { dataDir: string }> {
  const dataDir = join(await tempDir("jig-replica-"), "data");
  const started = await startService({ ...config, dataDir }, { secret: SECRET, runner });
  services.push(started);
  return { ...started, dataDir };
}

async function call(service: { url: string }, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(service.url + path, { method, headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const statusOf = (service: { url: string }, id: string, status: string) =>
  until(async () => {
    const { body } = await call(service, "GET", `/v1/tasks/${id}`);
    return body.status === status && body;
  }, `task ${id} to be ${status}`);

/** The fake jig's record of a run, in the folder of the replica that runs it. */
const record = (dataDir: string, id: string) =>
  until(async () => JSON.parse(await readFile(join(dataDir, "tasks", id, "work", ".fake-jig.json"), "utf8").catch(() => "null")), "the fake jig's record");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A task's server-sent events from a replica, frame by frame (id or event name, and data), as they come. */
async function* sse(service: { url: string }, path: string): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const res = await fetch(service.url + path, { headers: { authorization: `Bearer ${KEY}` } });
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += Buffer.from(chunk).toString("utf8");
    for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
      const frame: { id?: string; event?: string; data: string } = { data: "" };
      for (const line of buffer.slice(0, end).split("\n")) {
        const [, field, value] = /^([^:]*): ?(.*)$/.exec(line) ?? [];
        if (field === "id" || field === "event" || field === "data") frame[field] = value;
      }
      if (frame.data) yield frame;
    }
  }
}

/** One runner for every replica, whose runs end when the test says, counting how many run at once in all. */
class SharedRunner implements Runner {
  active = new Map<string, { tenant: string; end: () => void }>();
  started = 0;
  most = { all: 0, byTenant: {} as Record<string, number> };

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    let end!: () => void;
    const ended = new Promise<void>((done) => (end = done));
    this.active.set(task.id, { tenant: tenant.id, end });
    this.started++;
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

for (const { name, skip } of BACKENDS) {
  describe(`replicas of the task service on one database (${name})`, { skip: skip || sandboxProblem() }, () => {
    beforeEach(() => void (backend = name));

    it("keep to the global and each tenant's cap together, with many tasks posted to each", async () => {
      const config = await shared({
        concurrency: 3,
        tenants: [
          { id: "acme", keys: [sha256(KEY)], concurrency: 2 },
          { id: "globex", keys: [sha256("globex-key")], concurrency: 1 },
        ],
      });
      const runner = new SharedRunner();
      const replicas = [await replica(config, runner), await replica(config, runner)];
      const ids: string[] = [];
      const post = async (service: Service, key: string) => {
        const res = await fetch(`${service.url}/v1/tasks`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
        ids.push((await res.json()).id);
      };
      // Posted to both at once, so both look for work at once.
      await Promise.all(Array.from({ length: 24 }, (_, i) => post(replicas[i % 2], i % 3 ? KEY : "globex-key")));
      while (runner.started < 24 || runner.active.size) {
        await until(() => runner.active.size, "a run");
        // Ended one at a time, with a moment for both replicas to fill the slot.
        runner.active.values().next().value!.end();
        await new Promise((done) => setTimeout(done, 30));
        await Promise.all(replicas.map((service) => service.scheduler.settled()));
      }
      assert.deepEqual(runner.most, { all: 3, byTenant: { acme: 2, globex: 1 } });
      assert.equal((await replicas[0].store.inStatus("succeeded")).length, 24);
    });

    it("run a task posted to one on either, its events followed live and the task cancelled through the other", async () => {
      const config = await shared();
      const first = await replica(config);
      const id = (await call(first, "POST", "/v1/tasks", { prompt: "wait twice, then finish" })).body.id;
      await statusOf(first, id, "running");
      // A replica that starts while another runs a task leaves it alone.
      const second = await replica(config);
      const [owner, other] = first.scheduler.running() ? [first, second] : [second, first];
      assert.equal(owner, first);
      await new Promise((done) => setTimeout(done, 1500));
      assert.equal((await call(second, "GET", `/v1/tasks/${id}`)).body.status, "running");

      // The events come through the replica that doesn't run it, while the run goes on: the first four were
      // stored before the stream opened, and the fifth is written after, with the run still waiting for go2.
      const work = join(owner.dataDir, "tasks", id, "work");
      const frames = sse(other, `/v1/tasks/${id}/events`);
      const seen: string[] = [];
      while (seen.length < 4) {
        const { value } = await frames.next();
        seen.push(value!.id ?? value!.event!);
      }
      await writeFile(join(work, "go"), "");
      let timer: NodeJS.Timeout | undefined;
      const fifth = await Promise.race([frames.next(), new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), 5000)))]);
      clearTimeout(timer);
      assert.equal(fifth?.value?.id, "5", "the event jig wrote after the stream opened, before the run ended");
      assert.equal((await call(other, "GET", `/v1/tasks/${id}`)).body.status, "running");
      seen.push(fifth.value.id);
      await writeFile(join(work, "go2"), "");
      for await (const frame of frames) seen.push(frame.id ?? frame.event!);
      assert.deepEqual(seen, ["1", "2", "3", "4", "5", "6", "7", "done"]);
      assert.equal((await call(other, "GET", `/v1/tasks/${id}`)).body.status, "succeeded");

      // A cancel through the other replica reaches the run, and everything it started.
      const hang = (await call(first, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
      await until(() => first.scheduler.running() + second.scheduler.running(), "the run to start");
      const runs = first.scheduler.running() ? first : second;
      const away = runs === first ? second : first;
      const { pid, child } = await record(runs.dataDir, hang);
      assert.deepEqual(await call(away, "POST", `/v1/tasks/${hang}/cancel`), { status: 202, body: { id: hang, status: "running" } });
      await statusOf(away, hang, "cancelled");
      await until(() => !alive(pid) && !alive(child), "the fake jig and its child to be gone");
    });

    it("end the tasks of a replica that crashed once their leases run out", async () => {
      const config = await shared();
      const base = await tempDir("jig-replica-");
      // A replica of its own process, to kill, given its database as the deploy files give it, in JIG_DATABASE_URL.
      const { database, ...rest } = config;
      await writeFile(join(base, "service.json"), JSON.stringify({ ...rest, dataDir: join(base, "data") }));
      const env = { ...process.env, JIG_GATEWAY_SECRET: SECRET, JIG_DATABASE_URL: database };
      const crashing = spawn(process.execPath, [API, "--config", join(base, "service.json")], { env, stdio: ["ignore", "ignore", "pipe"] });
      children.push(crashing);
      let printed = "";
      crashing.stderr!.on("data", (chunk) => (printed += chunk));
      const url = await until(() => /listening on (\S+)/.exec(printed)?.[1], "the replica to listen");
      const id = (await call({ url }, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
      const { pid } = await record(join(base, "data"), id);
      pids.push(pid);

      const survivor = await replica(config);
      assert.equal((await call(survivor, "GET", `/v1/tasks/${id}`)).body.status, "running");
      crashing.kill("SIGKILL");
      const task = await statusOf(survivor, id, "error");
      assert.match(task.error, /the task service stopped while it ran \(the replica running it stopped renewing its lease/);
      // The survivor takes what is posted now.
      const next = (await call(survivor, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
      await statusOf(survivor, next, "succeeded");
    });
  });
}

describe("replicas purging tasks on one Postgres", { skip: NO_POSTGRES }, () => {
  const TERMS = { owner: "r1", leaseMs: 60_000, concurrency: 200, tenantConcurrency: 200 };
  const OUTCOME = { status: "succeeded" as const, exitCode: 0, stop: "end_turn", error: null, stats: null, usage: null, cost: null };
  const text = (seq: number) => ({ v: 1, seq, ts: "", type: "text", text: "said" });

  /** Two stores on one new database, a pool of the test's own on it, and a tenant "a". */
  async function two(): Promise<{ one: Store; other: Store; db: Pool }> {
    const url = await postgresDatabase();
    const [one, other] = [await openStore(url), await openStore(url)];
    const db = new Pool(url);
    opened.push(() => one.close(), () => other.close(), () => db.close());
    await one.putTenant({ id: "a", limits: { ...LIMITS, concurrency: 200 } }, []);
    return { one, other, db };
  }

  it("purge each old task once between them, a batch at a time", async () => {
    const { one, other, db } = await two();
    for (let i = 0; i < 100; i++) {
      const { id } = await one.createTask("a", QUIET);
      await one.claim("a", TERMS);
      await one.addEvent(id, 1, text(1));
      await one.finish(id, "r1", OUTCOME);
    }
    await sleep(20);
    const left = async () => Number((await db.query("SELECT count(*) AS n FROM tasks WHERE purged IS NULL")).rows[0].n);
    // Each until none is left: a batch is 0 while the other replica, or another test file, holds the lock.
    const loop = async (store: Store) => {
      const batches: number[] = [];
      for (;;) {
        const batch = await store.purgeEnded(1, 20);
        if (batch) batches.push(batch);
        else if (!(await left())) return batches;
      }
    };
    const batches = (await Promise.all([loop(one), loop(other)])).flat();
    assert.equal(batches.reduce((sum, batch) => sum + batch, 0), 100, batches.join(" "));
    assert.ok(batches.every((batch) => batch <= 20), batches.join(" "));
    assert.deepEqual((await db.query("SELECT (SELECT count(*) FROM events) AS events, (SELECT count(*) FROM tasks WHERE prompt = '') AS blank")).rows, [{ events: 0, blank: 100 }]);
  });

  it("leave no event of a purged task, whichever of the purge and the event's write comes first", async () => {
    const { one, other, db } = await two();
    const ended = async () => {
      const { id } = await one.createTask("a", QUIET);
      await one.claim("a", TERMS);
      await one.finish(id, "r1", OUTCOME);
      return id;
    };
    const events = async (id: string) => Number((await db.query("SELECT count(*) AS n FROM events WHERE task = $1", [id])).rows[0].n);
    /** A transaction of the test's own, held open until `commit` is called. */
    const held = async (begin: (client: Parameters<Parameters<Pool["transaction"]>[0]>[0]) => Promise<unknown>) => {
      let commit!: () => void;
      const go = new Promise<void>((done) => (commit = done));
      let began!: () => void;
      const ready = new Promise<void>((done) => (began = done));
      const done = db.transaction(async (client) => {
        await begin(client);
        began();
        await go;
      });
      await ready;
      // Let go after a test that failed too, or the pool's close would wait for it.
      opened.push(() => (commit(), done));
      return { commit: () => (commit(), done) };
    };
    const pending = async (promise: Promise<unknown>) => (await Promise.race([promise.then(() => false), sleep(200).then(() => true)]));

    // An event being written as the purge comes: the purge waits for it, then deletes it with the rest.
    const first = await ended();
    const writing = await held(async (client) => {
      await client.query("SELECT id FROM tasks WHERE id = $1 AND purged IS NULL FOR KEY SHARE", [first]);
      await client.query("INSERT INTO events (task, seq, json) VALUES ($1, 1, '{}')", [first]);
    });
    const purge = other.purge(first);
    assert.equal(await pending(purge), true);
    await writing.commit();
    assert.equal((await purge)!.first, true);
    assert.equal(await events(first), 0);

    // A purge under way as the event comes: its write waits for the purge, then stores nothing.
    const second = await ended();
    const purging = await held(async (client) => {
      await client.query("SELECT spec FROM tasks WHERE id = $1 FOR UPDATE", [second]);
      await client.query("UPDATE tasks SET purged = now() WHERE id = $1", [second]);
    });
    const [event, approval] = [one.addEvent(second, 1, text(1)), one.addApproval(second, { id: "ap_1", step: 1, tool: "bash", description: "rm" })];
    assert.deepEqual([await pending(event), await pending(approval)], [true, true]);
    await purging.commit();
    assert.deepEqual([await event, await approval], [undefined, undefined]);
    assert.deepEqual([await events(second), await one.approvals(second)], [0, []]);
  });

  it("renew a task's lease while one of its events is being written", async () => {
    const { one, other, db } = await two();
    const { id } = await one.createTask("a", QUIET);
    await one.claim("a", TERMS);
    // The store's own write of seq 1 waits for this one, of the same seq, holding its lock on the task.
    let rollback!: () => void;
    const undo = new Promise<void>((done) => (rollback = done));
    let began!: () => void;
    const ready = new Promise<void>((done) => (began = done));
    const open = db
      .transaction(async (client) => {
        await client.query("INSERT INTO events (task, seq, json) VALUES ($1, 1, '{}')", [id]);
        began();
        await undo;
        throw new Error("rolled back");
      })
      .catch(() => {});
    opened.push(() => (rollback(), open));
    await ready;
    const event = one.addEvent(id, 1, text(1));
    await until(async () => Number((await db.query("SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'")).rows[0].n) > 0 || undefined, "the event's write to wait");
    const renewed = await Promise.race([other.renew([id], "r1", 60_000), sleep(3000).then(() => "waited")]);
    assert.deepEqual(renewed, [{ id, cancel: false }]);
    rollback();
    await open;
    await event;
    assert.equal((await one.events(id)).length, 1);
  });
});

/** A store on the SQLite file, closed after the test. */
async function sqliteStore(file: string): Promise<Store> {
  const store = await openStore(file);
  opened.push(() => store.close());
  return store;
}

/** A scheduler, closed after the test. */
function newScheduler(...args: ConstructorParameters<typeof Scheduler>): Scheduler {
  const scheduler = new Scheduler(...args);
  opened.push(() => scheduler.close());
  return scheduler;
}

/** Runs that write no events (waiting on an approval, or a long build) until they are ended or cancelled, each in a folder of its own. */
class QuietRunner implements Runner {
  ends = new Map<string, () => void>();
  cancelled: string[] = [];
  abandoned: string[] = [];
  readonly dataDir: string;
  constructor(dataDir = "") {
    this.dataDir = dataDir;
  }

  async start(task: Task): Promise<RunHandle> {
    if (this.dataDir) await mkdir(join(this.dataDir, "tasks", task.id, "work"), { recursive: true });
    let end!: () => void;
    const ended = new Promise<void>((done) => (end = done));
    this.ends.set(task.id, end);
    return {
      events: (async function* () {})(),
      wait: async () => (await ended, { exitCode: 0, timedOut: false }),
      cancel: () => {
        this.cancelled.push(task.id);
        end();
      },
    };
  }

  /** How many times the folders were listed: a sweep's. */
  listed = 0;
  async leftovers(): Promise<Leftover[]> {
    const folders = await taskFolders(this.dataDir);
    this.listed++;
    return folders;
  }

  async abandon(id: string): Promise<void> {
    this.abandoned.push(id);
  }

  async removeFiles(id: string): Promise<void> {
    await rm(join(this.dataDir, "tasks", id), { recursive: true, force: true });
  }
}

const QUIET = { prompt: "x", maxSteps: 10, timeLimit: 600, model: "claude-x" };
const LIMITS = { concurrency: 2, maxSteps: 10, timeLimit: 600, budgetUsd: null };
const exists = (path: string) => access(path).then(() => true, () => false);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A folder left for a task the store doesn't have (another service's on the same dataDir, or a task the
 * store forgot), with a run's work folder in it, last changed `ago` ms back; with `events`, a run still writes
 * its events.jsonl.
 */
async function unknownFolder(dataDir: string, ago: number, events = false): Promise<string> {
  const folder = join(dataDir, "tasks", `task_${randomBytes(16).toString("hex")}`);
  await mkdir(join(folder, "work"), { recursive: true });
  const then = new Date(Date.now() - ago);
  await utimes(join(folder, "work"), then, then);
  if (events) await writeFile(join(folder, "events.jsonl"), "{}\n");
  await utimes(folder, then, then);
  return folder;
}

// How a replica's store behaves while the database is down: its calls fail, as in a Postgres failover, or
// they hang until its link heals and then go through, as in a network partition or a paused server.
const OUTAGES = [
  { name: "fail", hang: false },
  { name: "hang", hang: true },
] as const;

describe("replicas that lose the database", () => {
  for (const { name: outage, hang } of OUTAGES) {
    it(`don't end each other's tasks when all lose it for longer than a lease (calls ${outage})`, async () => {
      const file = join(await tempDir("jig-replicas-"), "jig.db");
      let down = false;
      let back!: () => void;
      const up = new Promise<void>((done) => (back = done));
      const flaky = (store: Store, heal: number): Store => {
        // Each replica's link heals at its own time after the database is back.
        const healed = up.then(() => new Promise<void>((done) => setTimeout(done, heal)));
        return new Proxy(store, {
          get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver);
            if (typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              if (down && !hang) throw new Error("the database went away");
              if (down) await healed;
              return value.apply(target, args);
            };
          },
        });
      };
      const base = await sqliteStore(file);
      for (const id of ["acme", "beta"]) await base.putTenant({ id, limits: { ...LIMITS, concurrency: 1 } }, []);
      const lease = 3000;
      const runners = [new QuietRunner(), new QuietRunner()];
      const a = newScheduler(flaky(await sqliteStore(file), 0), runners[0], { concurrency: 2, replicaId: "A", leaseMs: lease });
      const b = newScheduler(flaky(await sqliteStore(file), 300), runners[1], { concurrency: 2, replicaId: "B", leaseMs: lease });
      await a.start();
      // Their renewals out of step, as two pods' are.
      await new Promise((done) => setTimeout(done, lease / 6));
      await b.start();
      // A task runs on each.
      const tasks = [await base.createTask("acme", QUIET)];
      await a.poke();
      tasks.push(await base.createTask("beta", QUIET));
      await b.poke();
      assert.deepEqual([a.running(), b.running()], [1, 1]);
      await new Promise((done) => setTimeout(done, 500));

      // Down for longer than a lease: every lease has run out by the time it comes back.
      down = true;
      await new Promise((done) => setTimeout(done, lease + 1000));
      down = false;
      back();
      await new Promise((done) => setTimeout(done, lease + 300));
      for (const task of tasks) assert.equal((await base.task(task.id))!.status, "running", `${task.tenant}'s task`);
      assert.deepEqual(runners.flatMap((runner) => runner.cancelled), []);
      for (const runner of runners) for (const end of runner.ends.values()) end();
      await Promise.all([a.settled(), b.settled()]);
      for (const task of tasks) assert.equal((await base.task(task.id))!.status, "succeeded");
    });
  }

  it("don't end each other's tasks when all lose it for less than a lease and one's round hangs for less than two ticks", async () => {
    const file = join(await tempDir("jig-replicas-"), "jig.db");
    let down = false;
    let back!: () => void;
    const up = new Promise<void>((done) => (back = done));
    // Calls hang while it is down, and go through once each replica's link heals, B's 300 ms after A's.
    const flaky = (store: Store, heal: number): Store => {
      const healed = up.then(() => sleep(heal));
      return new Proxy(store, {
        get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (down) await healed;
            return value.apply(target, args);
          };
        },
      });
    };
    const base = await sqliteStore(file);
    for (const id of ["acme", "beta"]) await base.putTenant({ id, limits: { ...LIMITS, concurrency: 1 } }, []);
    const lease = 4500;
    const tick = lease / 3;
    const runners = [new QuietRunner(), new QuietRunner()];
    const a = newScheduler(flaky(await sqliteStore(file), 0), runners[0], { concurrency: 2, replicaId: "A", leaseMs: lease });
    const b = newScheduler(flaky(await sqliteStore(file), 300), runners[1], { concurrency: 2, replicaId: "B", leaseMs: lease });
    await a.start();
    // A's rounds come half a tick after B's.
    await sleep(tick / 2);
    const bBegan = Date.now();
    await b.start();
    const tasks = [await base.createTask("acme", QUIET)];
    await a.poke();
    tasks.push(await base.createTask("beta", QUIET));
    await b.poke();
    assert.deepEqual([a.running(), b.running()], [1, 1]);

    // Cut off just before one of B's rounds, so its leases were renewed a tick before; A's next round starts
    // half a tick in. Back after 3.4 s: B's leases ran out 0.4 s before, while A's round hung for 2.6 s, less
    // than two ticks, so it doesn't count as failed.
    await sleep(tick + tick - ((Date.now() - bBegan) % tick) - 50);
    down = true;
    await sleep(3400);
    down = false;
    back();
    await sleep(lease);
    for (const task of tasks) assert.equal((await base.task(task.id))!.status, "running", `${task.tenant}'s task`);
    assert.deepEqual(runners.flatMap((runner) => runner.cancelled), []);
    for (const runner of runners) for (const end of runner.ends.values()) end();
    await Promise.all([a.settled(), b.settled()]);
    for (const task of tasks) assert.equal((await base.task(task.id))!.status, "succeeded");
  });

  it("don't end each other's tasks when one starts just as the database comes back after a lease", async () => {
    const file = join(await tempDir("jig-replicas-"), "jig.db");
    let down = false;
    const flaky = (store: Store): Store =>
      new Proxy(store, {
        get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver);
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            if (down) throw new Error("the database went away");
            return value.apply(target, args);
          };
        },
      });
    const base = await sqliteStore(file);
    await base.putTenant({ id: "acme", limits: LIMITS }, []);
    const lease = 3000;
    const runner = new QuietRunner();
    const a = newScheduler(flaky(await sqliteStore(file)), runner, { concurrency: 2, replicaId: "A", leaseMs: lease });
    await a.start();
    // A's rounds come every third of a lease from here.
    const began = Date.now();
    const task = await base.createTask("acme", QUIET);
    await a.poke();
    assert.equal(a.running(), 1);

    // Down for longer than a lease, and back halfway between two of A's rounds. A replica that couldn't
    // start meanwhile (a pod crash-looping on the database) starts as it comes back.
    down = true;
    await sleep(lease + 1000);
    await sleep(lease / 3 - ((Date.now() - began) % (lease / 3)) + lease / 6);
    down = false;
    const c = newScheduler(await sqliteStore(file), new QuietRunner(), { concurrency: 2, replicaId: "C", leaseMs: lease, keepTaskDirs: true });
    await c.start();
    // C's first round comes after A's has renewed its lease, and a round of A's later, it still holds it.
    await sleep(lease);
    assert.equal((await base.task(task.id))!.status, "running");
    assert.deepEqual(runner.cancelled, []);
    runner.ends.get(task.id)!();
    await a.settled();
    assert.equal((await base.task(task.id))!.status, "succeeded");
  });

  it("end a gone replica's tasks while every round of renewals takes over a third of a lease", async () => {
    const store = await sqliteStore(join(await tempDir("jig-replicas-"), "jig.db"));
    await store.putTenant({ id: "acme", limits: LIMITS }, []);
    const task = await store.createTask("acme", QUIET);
    // Its lease runs out a second after the start, so only the rounds of renewals can end it.
    await store.claim("acme", { owner: "a crashed replica", leaseMs: 1000, concurrency: 2, tenantConcurrency: 2 });
    // A database that is slow but works: each heartbeat takes 250 ms, past a third of the 600 ms lease, not two.
    const slow = new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (name === "heartbeat") return async (...args: unknown[]) => (await sleep(250), value.apply(target, args));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const lines: string[] = [];
    const log = createLog("service", { write: (line) => lines.push(line) });
    await newScheduler(slow, new QuietRunner(), { concurrency: 2, replicaId: "B", leaseMs: 600, keepTaskDirs: true, log }).start();
    await until(async () => (await store.task(task.id))!.status === "error", "the gone replica's task to end");
    assert.ok(lines.some((line) => line.includes("took longer than a third of a lease")), lines.join("\n"));
    await until(() => lines.some((line) => line.includes("1 task(s) whose replica is gone (a crash, or a kill) marked as errors")), "the warning");
  });

  it("remove at start the folders of tasks that ended over a lease ago, or that the store lacks and are stale, and no other", async () => {
    const base = await tempDir("jig-replicas-");
    const file = join(base, "jig.db");
    const dataDir = join(base, "data");
    const store = await sqliteStore(file);
    await store.putTenant({ id: "acme", limits: { ...LIMITS, concurrency: 3 } }, []);
    // A replica crashes before it removes the folders of two tasks that finished; another task still runs on it.
    const crashed = new QuietRunner(dataDir);
    crashed.removeFiles = async () => {};
    const a = newScheduler(store, crashed, { concurrency: 3, replicaId: "A" });
    const [done, recent, running] = [await store.createTask("acme", QUIET), await store.createTask("acme", QUIET), await store.createTask("acme", QUIET)];
    await a.start();
    // Its own sweep at start has listed what was there by then.
    await until(() => crashed.ends.size === 3 && crashed.listed === 1, "the runs to start, and the sweep to list the folders");
    crashed.ends.get(done.id)!();
    crashed.ends.get(recent.id)!();
    await a.settled();
    for (const task of [done, recent]) assert.equal((await store.task(task.id))!.status, "succeeded");
    // One ended a minute ago, longer than a lease; the other just now, within one.
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE tasks SET ended = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), done.id);
    db.close();
    // Folders of tasks the store lacks: one unchanged for 11 minutes, one just made, and one whose run still
    // writes its events, in a folder unchanged for 11 minutes.
    const stale = await unknownFolder(dataDir, 11 * 60_000);
    const fresh = await unknownFolder(dataDir, 0);
    const busy = await unknownFolder(dataDir, 11 * 60_000, true);
    // A warm worker's folder isn't a task's.
    const pool = join(dataDir, "tasks", "pool_0123456789abcdef01234567");
    await mkdir(pool);
    const folders = [...[done, recent, running].map((task) => join(dataDir, "tasks", task.id)), stale, fresh, busy, pool];
    // The runners that keep the folders on this machine list them so, with when each last changed.
    const ids = (leftovers: Leftover[]) => leftovers.map(({ id }) => id).sort();
    const listed = folders.slice(0, -1).map((folder) => folder.split("/").pop()!).sort();
    const local = new LocalRunner({ dataDir, jig: [], gatewayBaseUrl: "", gatewaySecret: "", graceSeconds: 0 });
    const docker = new DockerRunner({ dataDir, image: "", network: "", gatewayBaseUrl: "", gatewaySecret: "", graceSeconds: 0 });
    assert.deepEqual([ids(await local.leftovers()), ids(await docker.leftovers())], [listed, listed]);
    const changed = new Map((await local.leftovers()).map(({ id, changed }) => [join(dataDir, "tasks", id), changed]));
    assert.ok(changed.get(stale)! < Date.now() - 10 * 60_000, "the stale folder's time");
    assert.ok(changed.get(busy)! > Date.now() - 60_000, "the busy folder's time, its events.jsonl's");
    assert.deepEqual(await taskFolders(join(base, "nowhere")), []);

    // With keepTaskDirs, every folder stays.
    const kept = serviceMetrics();
    const keeping = new QuietRunner(dataDir);
    await newScheduler(store, keeping, { concurrency: 2, replicaId: "C", keepTaskDirs: true, metrics: kept }).start();
    assert.deepEqual(await Promise.all(folders.map(exists)), folders.map(() => true));
    assert.equal(kept.foldersRemoved.get(), 0);
    assert.equal(keeping.listed, 0);

    const metrics = serviceMetrics();
    const sweeper = new QuietRunner(dataDir);
    const b = newScheduler(store, sweeper, { concurrency: 2, replicaId: "B", metrics });
    await b.start();
    await until(() => metrics.foldersRemoved.get() === 2, "the sweep to remove two folders");
    // Once it has closed, its sweep is done.
    await b.close();
    assert.deepEqual(await Promise.all(folders.map(exists)), [false, true, true, false, true, true, true]);
    assert.equal(metrics.foldersRemoved.get(), 2);
    assert.deepEqual(sweeper.abandoned.sort(), [done.id, stale.split("/").pop()!].sort());
    assert.deepEqual(keeping.abandoned, []);
  });

  it("start without waiting for the sweep, which stops at the next folder once the service stops", async () => {
    const base = await tempDir("jig-replicas-");
    const dataDir = join(base, "data");
    const store = await sqliteStore(join(base, "jig.db"));
    const folders = [await unknownFolder(dataDir, 11 * 60_000), await unknownFolder(dataDir, 11 * 60_000)];
    // Stopping each run left takes as long as it takes (a docker kill on a slow daemon, say).
    const runner = new QuietRunner(dataDir);
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    runner.abandon = async (id) => {
      runner.abandoned.push(id);
      await held;
    };
    const metrics = serviceMetrics();
    const scheduler = newScheduler(store, runner, { concurrency: 1, replicaId: "A", metrics });
    // Released before the scheduler is closed after the test, should it fail.
    opened.push(async () => release());
    const started = await Promise.race([scheduler.start().then(() => true), sleep(2000).then(() => false)]);
    assert.ok(started, "start waited for the sweep");
    await until(() => runner.abandoned.length === 1, "the sweep to stop the first run");
    let closed = false;
    const closing = scheduler.close().then(() => (closed = true));
    await sleep(200);
    assert.equal(closed, false, "close didn't wait for the folder being removed");
    release();
    await closing;
    assert.equal(metrics.foldersRemoved.get(), 1);
    assert.equal(runner.abandoned.length, 1);
    assert.deepEqual((await Promise.all(folders.map(exists))).sort(), [false, true]);
  });

  it("sweep the folders runs left every tenth round of renewals", async () => {
    const base = await tempDir("jig-replicas-");
    const dataDir = join(base, "data");
    const store = await sqliteStore(join(base, "jig.db"));
    const runner = new QuietRunner(dataDir);
    const metrics = serviceMetrics();
    // The start and each round renew the heartbeat; a sweep's listing notes how many had been renewed by then.
    let beats = 0;
    const heartbeat = store.heartbeat.bind(store);
    store.heartbeat = (replica, ms) => (beats++, heartbeat(replica, ms));
    const listings: number[] = [];
    const list = runner.leftovers.bind(runner);
    runner.leftovers = () => (listings.push(beats), list());
    // A round every 100 ms.
    await newScheduler(store, runner, { concurrency: 1, replicaId: "A", leaseMs: 300, metrics }).start();
    await until(() => runner.listed === 1, "the sweep at start");
    const folder = await unknownFolder(dataDir, 11 * 60_000);
    await until(() => metrics.foldersRemoved.get() === 1, "a sweep to remove the folder");
    assert.equal(await exists(folder), false);
    // One sweep since the start's, not one a round: it came after the start's heartbeat and ten rounds'.
    assert.equal(runner.listed, 2);
    assert.ok(listings[1]! >= 11, `the second sweep came after ${listings[1]} heartbeats`);
  });
});
