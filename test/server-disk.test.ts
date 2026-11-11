import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, link, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { checkConfig, type Config, diskRisks, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { PgError } from "../server/pg.ts";
import { DISK_UNMEASURABLE, diskError, folderBytes, Gone, type Runner, statusFor, Unmeasurable, watchDisk } from "../server/runner.ts";
import { DockerRunner } from "../server/runners/docker.ts";
import { LocalRunner } from "../server/runners/local.ts";
import { DB_FULL, outcomeOf, Scheduler } from "../server/scheduler.ts";
import { serviceMetrics } from "../server/service-metrics.ts";
import { diskFull, openStore, type Store, type Task, type Tenant } from "../server/store.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The disk cap on a task's folder (server/runner.ts's folderBytes and watchDisk, the local and Docker
// runners), and a full database's disk: SQLite's SQLITE_FULL told from other failures (store.ts), a run's
// folder removed before its outcome is tried again (scheduler.ts), and the API's 503 (api.ts). The fake jig
// writes real bytes; no disk is filled, and no docker or model is run.

const FIXTURES = join(import.meta.dirname, "fixtures");
const FAKE_JIG = join(FIXTURES, "fake-jig.mjs");
const FAKE_DOCKER = join(FIXTURES, "fake-docker.mjs");
const SECRET = "the gateway's secret";
const KEY = "acme-key";
const TENANT: Tenant = { id: "acme", limits: { concurrency: 2, maxSteps: 50, timeLimit: 600, budgetUsd: null } };
const MIB = 1024 * 1024;

const services: Service[] = [];
const opened: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close().catch(() => {});
  await Promise.all(services.splice(0).map((service) => service.close()));
  await removeTempDirs();
});

/** The service with the given runner and one tenant, acme, with its key, on a SQLite file of its own. */
async function service(runner: Runner, config: Partial<Config> = {}): Promise<Service> {
  const base = await tempDir("jig-disk-");
  const started = await startService(
    { port: 0, internal: { port: 0 }, database: join(base, "jig.db"), dataDir: join(base, "data"), gatewayBaseUrl: "http://gateway:8081/anthropic", graceSeconds: 5, tenants: [{ id: "acme", keys: [createHash("sha256").update(KEY).digest("hex")] }], ...config },
    { secret: SECRET, runner },
  );
  services.push(started);
  return started;
}

async function call(service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(service.url + path, { method, headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string): Promise<T> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ended = (service: Service, id: string) =>
  until(async () => {
    const { body } = await call(service, "GET", `/v1/tasks/${id}`);
    return body.ended && body;
  }, `task ${id} to end`);

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A log whose JSON lines go to `lines`. */
function logTo(lines: any[]) {
  return createLog("service", { format: "json", level: "debug", write: (line) => lines.push(JSON.parse(line)) });
}

/** The error node:sqlite throws when the database's disk is full. */
const full = () => Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13, errstr: "database or disk is full" });

/**
 * Makes the store's next `times` COMMITs fail as they do on a full disk: SQLite has rolled the transaction
 * back by the time COMMIT returns SQLITE_FULL. Gives what undoes it.
 */
function failCommits(store: Store, times = Infinity): () => void {
  const db = (store as unknown as { db: { exec(sql: string): void } }).db;
  const exec = db.exec.bind(db);
  db.exec = (sql: string) => {
    if (sql !== "COMMIT" || times-- <= 0) return exec(sql);
    exec("ROLLBACK");
    throw full();
  };
  return () => void (db.exec = exec);
}

describe("a folder's size on the disk", () => {
  const KB300 = Buffer.alloc(300_000, 1);

  it("counts the blocks of everything in it, following no link and counting a file with two names once", async () => {
    const base = await tempDir("jig-disk-");
    const dir = join(base, "task");
    const outside = join(base, "outside");
    await mkdir(join(dir, "work", "deep"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "big"), KB300);
    const empty = await folderBytes(dir, Infinity);
    assert.ok(empty < 100_000, `the folders alone: ${empty}`);

    await writeFile(join(dir, "work", "deep", "a"), KB300);
    const one = await folderBytes(dir, Infinity);
    assert.ok(one >= 300_000 && one < 400_000, `a 300 KB file: ${one}`);

    // Links to a folder, to a file and to /etc are counted as links, and a hole in a file for nothing.
    await symlink(outside, join(dir, "work", "out"));
    await symlink(join(outside, "big"), join(dir, "work", "big"));
    await symlink("/etc", join(dir, "work", "etc"));
    await writeFile(join(dir, "work", "sparse"), "");
    await truncate(join(dir, "work", "sparse"), 1024 ** 3);
    const linked = await folderBytes(dir, Infinity);
    assert.ok(linked >= one && linked < one + 100_000, `links and a hole: ${linked} after ${one}`);

    await link(join(dir, "work", "deep", "a"), join(dir, "work", "again"));
    await link(join(dir, "work", "deep", "a"), join(dir, "work", "deep", "and-again"));
    const twice = await folderBytes(dir, Infinity);
    assert.ok(twice < linked + 100_000, `a file with three names: ${twice} after ${linked}`);
  });

  it("stops as soon as it is past the limit", async () => {
    const dir = await tempDir("jig-disk-");
    for (const name of ["a", "b", "c", "d"]) await writeFile(join(dir, name), KB300);
    const bytes = await folderBytes(dir, 1000);
    assert.ok(bytes > 1000 && bytes < 400_000, `one file was enough: ${bytes}`);
    assert.ok((await folderBytes(dir, Infinity)) >= 1_200_000);
  });

  it("leaves out what goes away while it walks, and says when the folder itself is gone", async () => {
    const dir = await tempDir("jig-disk-");
    for (let n = 0; n < 20; n++) {
      await mkdir(join(dir, `sub${n}`));
      for (let m = 0; m < 20; m++) await writeFile(join(dir, `sub${n}`, `file${m}`), "x");
    }
    const walk = folderBytes(dir, Infinity);
    await Promise.all(Array.from({ length: 20 }, (_, n) => rm(join(dir, `sub${n}`), { recursive: true })));
    assert.ok((await walk) >= 0);
    await assert.rejects(folderBytes(join(dir, "none"), Infinity), Gone);
  });

  it("can't measure a folder it can't read", { skip: process.getuid?.() === 0 && "root reads every folder" }, async () => {
    const dir = await tempDir("jig-disk-");
    await mkdir(join(dir, "work", "closed"), { recursive: true });
    await chmod(join(dir, "work", "closed"), 0);
    try {
      await assert.rejects(folderBytes(dir, Infinity), (err) => err instanceof Unmeasurable && err.code === "EACCES");
    } finally {
      await chmod(join(dir, "work", "closed"), 0o700);
    }
  });

  it("can't measure a path too long to name, nor a folder of more entries than it reads", async () => {
    const dir = await tempDir("jig-disk-");
    for (let n = 0; n < 5; n++) await writeFile(join(dir, `file${n}`), "x");
    assert.ok((await folderBytes(dir, Infinity, 5)) >= 0);
    await assert.rejects(folderBytes(dir, Infinity, 4), (err) => err instanceof Unmeasurable && err.code === "too many");

    // Folders in folders until the whole path is past what a path may be (4096 bytes on Linux, 1024 on
    // macOS), as a task's commands can make them, each by its name in the one before (cd -P: by that name alone).
    const deep = join(dir, "deep");
    await mkdir(deep);
    const name = "d".repeat(200);
    execFileSync("/bin/sh", ["-c", `cd "$1" && i=0 && while [ $i -lt 30 ]; do mkdir ${name} && cd -P ${name} || exit 1; i=$((i+1)); done`, "sh", deep]);
    try {
      await assert.rejects(folderBytes(dir, Infinity), (err) => err instanceof Unmeasurable && err.code === "ENAMETOOLONG");
    } finally {
      // rm removes them a folder at a time, where a whole path couldn't be named.
      execFileSync("rm", ["-rf", deep]);
    }
  });
});

describe("the watch of a task's folder", () => {
  /** A watch whose walks are `sizes` in turn (the last from then on): a number of bytes, or what the walk throws. */
  function watching(sizes: (number | Error)[], limit = 1000) {
    const calls: string[] = [];
    let walks = 0;
    const measure = async () => {
      const size = sizes[Math.min(walks++, sizes.length - 1)];
      if (size instanceof Error) throw size;
      return size;
    };
    const lines: any[] = [];
    const stop = watchDisk("/the/task", limit, (why) => calls.push(why), 10, { log: logTo(lines), measure });
    opened.push(async () => stop());
    return { calls, stop, walks: () => walks, lines };
  }

  it("calls once when the folder is past the limit, and then is over", async () => {
    const { calls, walks } = watching([10, 1000, 1001, 5000]);
    await until(() => calls.length, "the folder to be over");
    assert.equal(walks(), 3);
    await pause(100);
    assert.deepEqual(calls, ["the task's folder grew past maxTaskDiskBytes (1000 bytes), so the service stopped the run"]);
    assert.equal(calls[0], diskError(1000));
    assert.equal(walks(), 3);
  });

  it("never calls once it is stopped, though a walk was under way", async () => {
    let release!: (bytes: number) => void;
    const calls: string[] = [];
    let walks = 0;
    const stop = watchDisk("/the/task", 1000, (why) => calls.push(why), 10, { measure: () => (walks++, new Promise((done) => (release = done))) });
    await until(() => walks === 1, "a walk to start");
    stop();
    release(5000);
    await pause(100);
    assert.deepEqual([calls, walks], [[], 1]);
  });

  it("ends a task whose folder can't be measured twice in a row, not once", async () => {
    const unreadable = new Unmeasurable("EACCES");
    const once = watching([unreadable, 10, unreadable, 10, 10]);
    await until(() => once.walks() >= 6, "six walks");
    assert.deepEqual(once.calls, []);
    once.stop();

    const twice = watching([10, unreadable, unreadable, 10]);
    await until(() => twice.calls.length, "the folder to be given up on");
    await pause(100);
    assert.deepEqual(twice.calls, [DISK_UNMEASURABLE]);
    assert.match(DISK_UNMEASURABLE, /^the task's folder can't be measured \(a folder the service can't read, a path too long, or over 1000000 files\), so it can't be held to maxTaskDiskBytes: the service stopped the run$/);
    assert.equal(twice.walks(), 3);
  });

  it("ends without a word when the folder is gone, and goes on past any other failure, logged once", async () => {
    const gone = watching([10, new Gone("gone"), 5000]);
    await until(() => gone.walks() === 2, "two walks");
    await pause(100);
    assert.deepEqual([gone.calls, gone.walks()], [[], 2]);

    const failing = watching([new Error("EIO"), new Error("EIO"), new Error("EIO"), 5000]);
    await until(() => failing.calls.length, "the folder to be over");
    assert.equal(failing.lines.filter((line) => line.level === "warn").length, 1);
  });

  it("walks one folder at a time, however many are watched", async () => {
    let walking = 0;
    let most = 0;
    let walks = 0;
    const measure = async () => {
      most = Math.max(most, ++walking);
      walks++;
      await pause(5);
      walking--;
      return 10;
    };
    for (let n = 0; n < 8; n++) {
      const stop = watchDisk(`/task/${n}`, 1000, () => {}, 10, { measure });
      opened.push(async () => stop());
    }
    await until(() => walks >= 24, "the watches to walk");
    assert.equal(most, 1);
  });

  it("waits ten times as long as a walk took before the next", async () => {
    const starts: number[] = [];
    const measure = async () => {
      starts.push(Date.now());
      await pause(30);
      return 10;
    };
    const stop = watchDisk("/the/task", 1000, () => {}, 10, { measure });
    opened.push(async () => stop());
    await until(() => starts.length >= 3, "three walks");
    // 30 ms of walk, then 300 ms and not 10.
    assert.ok(starts[2] - starts[1] >= 300, `${starts[2] - starts[1]} ms between two walks`);
  });

  it("doesn't keep the process going", async () => {
    const script = `const { watchDisk } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "server", "runner.ts")).href)}); watchDisk(process.cwd(), 1e12, () => {}, 600_000);`;
    const began = Date.now();
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 60_000 });
    assert.ok(Date.now() - began < 30_000);
  });
});

describe("a run stopped at the disk cap", () => {
  const overDisk = diskError(MIB);

  it("is an error, whatever its exit code or the time limit, unless it was cancelled", () => {
    assert.equal(statusFor({ exitCode: 143, overDisk }), "error");
    assert.equal(statusFor({ exitCode: 0, overDisk }), "error");
    assert.equal(statusFor({ exitCode: null, timedOut: true, overDisk }), "error");
    assert.equal(statusFor({ exitCode: 143, overDisk, cancelled: true }), "cancelled");
  });

  it("has stop disk_limit and the cap's text, though jig's end says interrupted, and keeps what the run spent", () => {
    const exit = { exitCode: 143, timedOut: false, overDisk };
    const killed = outcomeOf(exit, undefined, undefined, undefined);
    assert.deepEqual([killed.status, killed.stop, killed.error], ["error", "disk_limit", overDisk]);
    const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
    const end = { v: 1, seq: 9, ts: "", type: "end", stop: "interrupted", usage, cost: 0.25 };
    const told = outcomeOf(exit, end, undefined, undefined);
    assert.deepEqual([told.status, told.stop, told.error, told.usage, told.cost], ["error", "disk_limit", overDisk, usage, 0.25]);
    // A stop of the run's own, reached first, stays.
    const own = outcomeOf(exit, { ...end, stop: "max_steps" }, undefined, undefined);
    assert.deepEqual([own.status, own.stop, own.error], ["error", "max_steps", overDisk]);
    // A cancel, a shutdown or a lost lease that was stopping it says how it ended.
    const cancelled = outcomeOf(exit, undefined, undefined, "cancelled");
    assert.deepEqual([cancelled.status, cancelled.stop, cancelled.error], ["cancelled", "interrupted", null]);
    assert.deepEqual(outcomeOf(exit, end, undefined, "shutdown").stop, "interrupted");
  });
});

describe("the local runner's disk cap", () => {
  const options = (base: string, config: Partial<ConstructorParameters<typeof LocalRunner>[0]> = {}) => ({ dataDir: join(base, "data"), jig: [process.execPath, FAKE_JIG], gatewayBaseUrl: "http://gateway:8081/anthropic", gatewaySecret: SECRET, graceSeconds: 5, pollMs: 20, diskPollMs: 20, ...config });
  const groupAlive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("stops a run whose folder grows past the cap, as an error with stop disk_limit, and removes the folder", async () => {
    const lines: any[] = [];
    const runner = new LocalRunner(options(await tempDir("jig-disk-"), { maxDiskBytes: MIB, log: logTo(lines) }));
    // The run's pid, read as its folder is removed.
    const pids: number[] = [];
    const remove = runner.removeFiles.bind(runner);
    runner.removeFiles = async (id) => {
      pids.push(JSON.parse(readFileSync(join(runner.dir(id), "run.json"), "utf8")).pid);
      await remove(id);
    };
    const api = await service(runner);
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "fill 3000000 hang", model: "claude-haiku-4-5" })).body.id;
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop], ["error", "disk_limit"]);
    assert.match(task.error, /grew past maxTaskDiskBytes \(1048576 bytes\)/);
    assert.equal(task.error, diskError(MIB));
    // jig's own end, written as it was stopped, is kept with what it spent.
    assert.equal(task.cost, 0.001);
    await until(() => pids.length === 1 && !groupAlive(pids[0]), "the run's process group to be gone");
    await until(() => !existsSync(runner.dir(id)), "the task's folder to be removed");
    const warned = lines.filter((line) => line.msg === "stopping a task whose folder went past the disk cap");
    assert.deepEqual(warned.map(({ tenant, task, why }) => ({ tenant, task, why })), [{ tenant: "acme", task: id, why: diskError(MIB) }]);
  });

  it("lets a run within the cap be, and one of any size with no cap", async () => {
    const runner = new LocalRunner(options(await tempDir("jig-disk-"), { maxDiskBytes: MIB }));
    const capped = await service(runner, { keepTaskDirs: true });
    const small = (await call(capped, "POST", "/v1/tasks", { prompt: "fill 100000 wait", workspace: { files: { "app.py": "print(1)\n" } } })).body.id;
    await until(() => existsSync(join(runner.dir(small), "work", ".fake-jig.json")), "the small task's jig to wait");
    // Through many checks of its folder.
    await pause(300);
    assert.equal((await call(capped, "GET", `/v1/tasks/${small}`)).body.status, "running");
    await writeFile(join(runner.dir(small), "work", "go"), "");
    const done = await ended(capped, small);
    assert.deepEqual([done.status, done.stop, done.error], ["succeeded", "end_turn", null]);

    const free = await service(new LocalRunner(options(await tempDir("jig-disk-"), { maxDiskBytes: 0 })));
    const big = await ended(free, (await call(free, "POST", "/v1/tasks", { prompt: "fill 3000000 exit 0" })).body.id);
    assert.deepEqual([big.status, big.stop], ["succeeded", "end_turn"]);
  });

  it("ends a task whose workspace alone is past the cap before its jig starts", async () => {
    const runner = new LocalRunner(options(await tempDir("jig-disk-"), { maxDiskBytes: 100_000 }));
    const api = await service(runner, { keepTaskDirs: true });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "exit 0", workspace: { files: { "data.bin": "x".repeat(300_000) } } })).body.id;
    const task = await until(async () => {
      const { body } = await call(api, "GET", `/v1/tasks/${id}`);
      return body.status === "error" && body;
    }, "the task to end as an error");
    assert.deepEqual([task.status, task.stop, task.exitCode, task.error], ["error", null, null, diskError(100_000)]);
    assert.ok(!existsSync(join(runner.dir(id), "work", ".fake-jig.json")) && !existsSync(join(runner.dir(id), "events.jsonl")), "jig never started");
  });

  it("stops measuring the folder of a task that couldn't start", async () => {
    const lines: any[] = [];
    const base = await tempDir("jig-disk-");
    const runner = new LocalRunner(options(base, { maxDiskBytes: 100_000, log: logTo(lines) }));
    const now = new Date().toISOString();
    const task = (id: string, spec: Partial<Task["spec"]> = {}): Task => ({ id, tenant: "acme", spec: { prompt: "hang", maxSteps: 50, timeLimit: 600, model: "claude-haiku-4-5", ...spec }, status: "running", exitCode: null, stop: null, error: null, created: now, started: now, ended: null, stats: null, result: null, resultTruncated: false, purged: null, usage: null, cost: null });
    // A task with approvals and nowhere to ask for them: its start throws once its folder is made.
    await assert.rejects(runner.start(task("task_unasked", { approvals: true }), TENANT), /needs the service's internalBaseUrl/);
    // The folder, grown past the cap now, is no one's to stop.
    await writeFile(join(runner.dir("task_unasked"), "big"), Buffer.alloc(300_000, 1));
    await pause(300);
    assert.deepEqual(lines.filter((line) => line.level === "warn"), []);
  });
});

describe("the Docker runner's disk cap", () => {
  type Options = Partial<ConstructorParameters<typeof DockerRunner>[0]>;
  async function docker(config: Options = {}) {
    const base = await tempDir("jig-disk-");
    const state = join(base, "state");
    await mkdir(state);
    const runner = new DockerRunner({ dataDir: join(base, "data"), docker: [process.execPath, FAKE_DOCKER, state], image: "jig-worker:test", network: "jig-tasks", gatewayBaseUrl: "http://gateway:8081/anthropic", gatewaySecret: SECRET, graceSeconds: 5, pollMs: 20, diskPollMs: 20, ...config });
    const api = await service(runner, { keepTaskDirs: true, maxBodyBytes: 4 * MIB });
    const kills = async () => (await readFile(join(state, "kills.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { api, runner, state, kills };
  }

  it("stops a container whose task's folder grows past the cap, as an error with stop disk_limit", async () => {
    const { api, kills } = await docker({ maxDiskBytes: MIB });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "fill 3000000 hang" })).body.id;
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.error], ["error", "disk_limit", diskError(MIB)]);
    assert.deepEqual(await kills(), [{ signal: "TERM", name: `jig-${id}` }]);

    // A workspace past the cap by itself never gets a container.
    const heavy = (await call(api, "POST", "/v1/tasks", { prompt: "exit 0", workspace: { files: { a: "x".repeat(600_000), b: "x".repeat(600_000) } } })).body.id;
    const refused = await until(async () => {
      const { body } = await call(api, "GET", `/v1/tasks/${heavy}`);
      return body.status === "error" && body;
    }, "the heavy task to end");
    assert.deepEqual([refused.stop, refused.error], [null, diskError(MIB)]);
    assert.equal((await kills()).length, 1);

    // And one within it runs to its end.
    const light = await ended(api, (await call(api, "POST", "/v1/tasks", { prompt: "fill 100000 exit 0" })).body.id);
    assert.deepEqual([light.status, light.stop], ["succeeded", "end_turn"]);
  });

  it("measures a warm worker's folder once it has a task, and stops the worker past the cap", async () => {
    const { api, runner, state, kills } = await docker({ maxDiskBytes: MIB, pool: { size: 1 } });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "fill 3000000 hang" })).body.id;
    await until(() => runner.pool!.stats().hits === 1, "the warm worker to take the task");
    const folder = runner.dir(id);
    assert.match(folder, /[/\\]tasks[/\\]pool_[0-9a-f]{24}$/);
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.error], ["error", "disk_limit", diskError(MIB)]);
    const sent = await kills();
    assert.ok(sent.some(({ signal, name }) => signal === "TERM" && (name === `jig-${id}` || /^jig-pool_/.test(name))), JSON.stringify(sent));
    // The worker is gone: nothing of it answers a signal. Its pid is under the name it has now.
    const names = [`jig-${id}`, `jig-${folder.split(/[/\\]/).at(-1)}`];
    const pid = Number(names.filter((name) => existsSync(join(state, `${name}.pid`))).map((name) => readFileSync(join(state, `${name}.pid`), "utf8"))[0]);
    assert.ok(pid > 1);
    const groupAlive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !groupAlive(), "the worker's processes to be gone");
  });
});

describe("a full disk under the SQLite database", () => {
  const limits = { concurrency: 1, maxSteps: 5, timeLimit: 60, budgetUsd: null };
  const spec = { prompt: "x", maxSteps: 5, timeLimit: 60, model: "deepseek-flash" };

  /** A store that closes after the test, with tenant a. */
  async function newStore(path = ":memory:"): Promise<Store> {
    const store = await openStore(path);
    let open = true;
    const close = store.close.bind(store);
    store.close = async () => {
      if (open) await close();
      open = false;
    };
    opened.push(() => store.close());
    await store.putTenant({ id: "a", limits }, []);
    return store;
  }

  it("shows as SQLITE_FULL from a commit that failed, not as the rollback's 'no transaction is active'", async () => {
    const store = await newStore(join(await tempDir("jig-disk-"), "jig.db"));
    const task = await store.createTask("a", spec);
    assert.ok(typeof (await store.claim("a", { owner: "r", leaseMs: 60_000, concurrency: 4, tenantConcurrency: 4 })) === "object");
    const outcome = { status: "succeeded", exitCode: 0, stop: "end_turn", error: null, stats: null, usage: null, cost: null } as const;
    const restore = failCommits(store);
    const isFull = (err: unknown) => diskFull(err) && (err as { errcode: number }).errcode === 13;
    await assert.rejects(store.finish(task.id, "r", outcome), isFull);
    await assert.rejects(store.createTask("a", spec, { maxQueued: 10, now: new Date() }), isFull);
    await assert.rejects(store.putTenant({ id: "b", limits }, []), isFull);
    await assert.rejects(store.claim("a", { owner: "r", leaseMs: 60_000, concurrency: 4, tenantConcurrency: 4 }), isFull);
    restore();
    // Nothing of the failed writes is left, and the next gets through.
    assert.equal(await store.finish(task.id, "r", outcome), true);
    assert.equal((await store.task(task.id))!.status, "succeeded");
    assert.equal(await store.tenant("b"), undefined);
  });

  it("is told from other failures: SQLite's own error for no room, not Postgres's nor any other", async () => {
    const store = await newStore(join(await tempDir("jig-disk-"), "jig.db"));
    const task = await store.createTask("a", spec);
    // No more pages than it has: the next write that needs one finds the database full, as on a full disk.
    const db = (store as unknown as { db: { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> } } }).db;
    db.prepare(`PRAGMA max_page_count = ${Number(db.prepare("PRAGMA page_count").get().page_count)}`).get();
    const err = await store.addEvent(task.id, 1, { v: 1, seq: 1, ts: "", type: "text", text: "x".repeat(200_000) }).then(() => undefined, (err: unknown) => err);
    assert.ok(err, "the write failed");
    assert.equal((err as { errcode: number }).errcode & 0xff, 13);
    assert.equal(diskFull(err), true);
    assert.equal(diskFull(full()), true);
    // An extended code of it (none today) would be it too; others are not.
    assert.equal(diskFull({ code: "ERR_SQLITE_ERROR", errcode: 13 | (1 << 8) }), true);
    assert.equal(diskFull({ code: "ERR_SQLITE_ERROR", errcode: 1 }), false);
    assert.equal(diskFull({ code: "ERR_SQLITE_ERROR", errcode: 10 | (3 << 8) }), false);
    assert.equal(diskFull(new PgError({ C: "53100", M: "could not extend file: No space left on device" })), false);
    assert.equal(diskFull(new Error("database or disk is full")), false);
    assert.equal(diskFull(undefined), false);
  });

  /** The store, but for `method`, which throws SQLITE_FULL while `fails` says so of its second argument. */
  function fullStore(store: Store, method: keyof Store, fails: (second: unknown) => boolean, seen?: () => void): Store {
    return new Proxy(store, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver);
        if (name !== method) return typeof value === "function" ? value.bind(target) : value;
        return async (...args: unknown[]) => {
          seen?.();
          if (fails(args[1])) throw full();
          return value.apply(target, args);
        };
      },
    });
  }

  /** A runner whose runs write two notices and an end, and exit 0; `removed` is told of each folder removed. */
  function endsAtOnce(removed?: (id: string) => void): Runner {
    return {
      async start() {
        return {
          events: (async function* () {
            for (let seq = 1; seq <= 2; seq++) yield { v: 1, seq, ts: new Date().toISOString(), type: "notice", text: `notice ${seq}` };
            yield { v: 1, seq: 3, ts: new Date().toISOString(), type: "end", stop: "end_turn", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10 }, cost: 0.5 };
          })(),
          wait: async () => ({ exitCode: 0, timedOut: false }),
          cancel() {},
        };
      },
      ...(removed && { removeFiles: async (id: string) => removed(id) }),
    };
  }

  const endOf = (store: Store, id: string) =>
    until(async () => {
      const task = (await store.task(id))!;
      return task.status !== "running" && task.status !== "queued" && task;
    }, `task ${id} to end`);

  function newScheduler(...args: ConstructorParameters<typeof Scheduler>): Scheduler {
    const scheduler = new Scheduler(...args);
    opened.push(() => scheduler.close());
    return scheduler;
  }

  it("is ridden out by a run, whose events are written again until there is room", async () => {
    const store = await newStore();
    const task = await store.createTask("a", spec);
    let left = 2;
    const metrics = serviceMetrics();
    const scheduler = newScheduler(fullStore(store, "addEvent", (seq) => seq === 2 && left-- > 0), endsAtOnce(), { concurrency: 4, leaseMs: 60_000, metrics });
    await scheduler.poke();
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, ended.error], ["succeeded", null]);
    assert.deepEqual((await store.events(task.id)).map(({ seq }) => seq), [1, 2, 3]);
    assert.equal(metrics.storeErrors.get({ retried: "true" }), 2);
  });

  it("has the run's folder removed before its outcome is written again, once, unless folders are kept", async () => {
    for (const keepTaskDirs of [false, true]) {
      const store = await newStore();
      const task = await store.createTask("a", spec);
      const did: string[] = [];
      let left = 1;
      const flaky = fullStore(store, "finish", () => left-- > 0, () => did.push("finish"));
      const scheduler = newScheduler(flaky, endsAtOnce((id) => did.push(`remove ${id}`)), { concurrency: 4, leaseMs: 60_000, keepTaskDirs });
      await scheduler.poke();
      assert.equal((await endOf(store, task.id)).status, "succeeded");
      await scheduler.settled();
      assert.deepEqual(did, keepTaskDirs ? ["finish", "finish"] : ["finish", `remove ${task.id}`, "finish"]);
    }
  });

  it("ends a run whose events can't be written for half a lease, saying whose disk is full", async () => {
    const store = await newStore();
    const task = await store.createTask("a", spec);
    const scheduler = newScheduler(fullStore(store, "addEvent", (seq) => seq === 2), endsAtOnce(), { concurrency: 4, leaseMs: 1000 });
    await scheduler.poke();
    const ended = await endOf(store, task.id);
    assert.deepEqual([ended.status, ended.error], ["error", DB_FULL]);
    assert.equal(DB_FULL, "the service's database couldn't be written: its disk is full (the task was stopped)");
  });

  it("answers the API's writes with 503 and when to try again, not 500", async () => {
    const none: Runner = { start: () => Promise.reject(new Error("no task runs here")) };
    const api = await service(none);
    const restore = failCommits(api.store);
    opened.push(async () => restore());
    const refused = await call(api, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.deepEqual([refused.status, refused.body, refused.headers.get("retry-after")], [503, { error: "The service's database is out of disk space" }, "30"]);
    restore();
    assert.equal((await call(api, "GET", "/v1/tasks")).status, 200);
    assert.equal((await fetch(`${api.url}/readyz`)).status, 200);
  });
});

describe("the disk cap's config", () => {
  const base = { database: ":memory:", dataDir: "data", gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [] } satisfies Config;
  const problem = (config: object) => {
    try {
      checkConfig({ ...base, ...config } as Config);
      return undefined;
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("takes maxTaskDiskBytes as a whole number of bytes, 0 for none, and not at all on kubernetes", () => {
    assert.equal(problem({ maxTaskDiskBytes: -1 }), "The config's maxTaskDiskBytes must be a whole number from 0 up, not -1");
    assert.equal(problem({ maxTaskDiskBytes: 1.5 }), "The config's maxTaskDiskBytes must be a whole number from 0 up, not 1.5");
    assert.equal(problem({ maxTaskDiskBytes: 0 }), undefined);
    assert.equal(problem({ maxTaskDiskBytes: 8 * 1024 ** 3 }), undefined);
    assert.equal(problem({ runner: "docker", docker: { image: "w", network: "n" }, maxTaskDiskBytes: MIB }), undefined);
    const kubernetes = "The config's maxTaskDiskBytes is for the local and docker runners: on kubernetes, set the ephemeral-storage limit in kubernetes.resources";
    for (const maxTaskDiskBytes of [0, MIB, -1]) assert.equal(problem({ runner: "kubernetes", kubernetes: { image: "w" }, maxTaskDiskBytes }), kubernetes);
    assert.equal(problem({ runner: "kubernetes", kubernetes: { image: "w" } }), undefined);
  });

  it("warns at the start when a task has no cap, or dataDir's file system hasn't room for the tasks running at once", async () => {
    const dir = await tempDir("jig-disk-");
    const config: Config = { ...base, database: join(dir, "jig.db"), dataDir: join(dir, "data"), concurrency: 1 };
    const withDatabase = ", and the SQLite database is on that file system too: once it is full the database's writes fail and every running task ends as an error. Keep the database, or dataDir, on a file system of its own";
    assert.deepEqual(await diskRisks({ ...config, maxTaskDiskBytes: 0 }), [`maxTaskDiskBytes is 0, so a task's folder has no size limit and one task can fill dataDir's file system${withDatabase}`]);
    // A database that isn't a file here shares no file system with the tasks.
    assert.deepEqual(await diskRisks({ ...config, database: "postgres://jig@db.example.com/jig", maxTaskDiskBytes: 0 }), ["maxTaskDiskBytes is 0, so a task's folder has no size limit and one task can fill dataDir's file system"]);
    const [short, ...rest] = await diskRisks({ ...config, maxTaskDiskBytes: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(rest, []);
    assert.match(short, /^dataDir's file system has \d+ bytes free, less than concurrency × maxTaskDiskBytes \(1 × 9007199254740991\): the tasks running at once could fill it, and the SQLite database is on that file system too: .* of its own; lower either, or give dataDir more room$/);
    assert.deepEqual(await diskRisks({ ...config, maxTaskDiskBytes: MIB }), []);
    // The kubernetes runner keeps no folder here.
    assert.deepEqual(await diskRisks({ ...config, runner: "kubernetes", kubernetes: { image: "w" } }), []);
  });

  it("logs those warnings as the service starts on the local runner, and the cap is the runner's", async () => {
    const lines: any[] = [];
    const dir = await tempDir("jig-disk-");
    const config: Config = { port: 0, internal: { port: 0 }, database: join(dir, "jig.db"), dataDir: join(dir, "data"), gatewayBaseUrl: "http://127.0.0.1:9/anthropic", jig: [process.execPath, FAKE_JIG], local: { allowUnsandboxed: true }, maxTaskDiskBytes: 0, tenants: [{ id: "acme", keys: [createHash("sha256").update(KEY).digest("hex")] }] };
    const started = await startService(config, { secret: SECRET, log: logTo(lines) });
    services.push(started);
    assert.ok(lines.some((line) => line.level === "warn" && /^maxTaskDiskBytes is 0, so a task's folder has no size limit/.test(line.msg)), JSON.stringify(lines));
  });
});
