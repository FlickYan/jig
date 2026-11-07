import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type Config, type Service, startService } from "../server/api.ts";
import { type RunHandle, type Runner, taskFolders } from "../server/runner.ts";
import { DockerRunner } from "../server/runners/docker.ts";
import { LocalRunner } from "../server/runners/local.ts";
import { Scheduler } from "../server/scheduler.ts";
import { serviceMetrics } from "../server/service-metrics.ts";
import { openStore, type Store, type Task, type Tenant } from "../server/store.ts";
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
  describe(`replicas of the task service on one database (${name})`, { skip }, () => {
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
  private dataDir: string;
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

  leftovers(): Promise<string[]> {
    return taskFolders(this.dataDir);
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

  it("remove at start the folders that tasks which ended long ago left, and no running task's", async () => {
    const base = await tempDir("jig-replicas-");
    const file = join(base, "jig.db");
    const dataDir = join(base, "data");
    const store = await sqliteStore(file);
    await store.putTenant({ id: "acme", limits: LIMITS }, []);
    // A replica crashes before it removes the folder of a task that finished; another task still runs on it.
    const crashed = new QuietRunner(dataDir);
    crashed.removeFiles = async () => {};
    const a = newScheduler(store, crashed, { concurrency: 2, replicaId: "A" });
    const [done, running] = [await store.createTask("acme", QUIET), await store.createTask("acme", QUIET)];
    await a.start();
    await until(() => crashed.ends.size === 2, "both runs to start");
    crashed.ends.get(done.id)!();
    await a.settled();
    assert.equal((await store.task(done.id))!.status, "succeeded");
    // It ended a minute ago, longer than a lease.
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("UPDATE tasks SET ended = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), done.id);
    db.close();
    // A warm worker's folder isn't a task's.
    const pool = join(dataDir, "tasks", "pool_0123456789abcdef01234567");
    await mkdir(pool);
    const folders = [join(dataDir, "tasks", done.id), join(dataDir, "tasks", running.id), pool];
    // The runners that keep the folders on this machine list them so.
    const listed = [done.id, running.id].sort();
    const local = new LocalRunner({ dataDir, jig: [], gatewayBaseUrl: "", gatewaySecret: "", graceSeconds: 0 });
    const docker = new DockerRunner({ dataDir, image: "", network: "", gatewayBaseUrl: "", gatewaySecret: "", graceSeconds: 0 });
    assert.deepEqual([(await local.leftovers()).sort(), (await docker.leftovers()).sort()], [listed, listed]);
    assert.deepEqual(await taskFolders(join(base, "nowhere")), []);

    // With keepTaskDirs, every folder stays.
    const kept = serviceMetrics();
    const keeping = new QuietRunner(dataDir);
    await newScheduler(store, keeping, { concurrency: 2, replicaId: "C", keepTaskDirs: true, metrics: kept }).start();
    assert.deepEqual(await Promise.all(folders.map(exists)), [true, true, true]);
    assert.equal(kept.foldersRemoved.get(), 0);

    const metrics = serviceMetrics();
    const sweeper = new QuietRunner(dataDir);
    await newScheduler(store, sweeper, { concurrency: 2, replicaId: "B", metrics }).start();
    assert.deepEqual(await Promise.all(folders.map(exists)), [false, true, true]);
    assert.equal(metrics.foldersRemoved.get(), 1);
    assert.deepEqual(sweeper.abandoned, [done.id]);
    assert.deepEqual(keeping.abandoned, []);
  });
});
