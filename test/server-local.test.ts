import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { type Config, checkConfig, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { LocalRunner } from "../server/runners/local.ts";
import { openStore, type Task, type Tenant } from "../server/store.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The local runner and jig's sandbox: the runner's jig runs with --sandbox, so one that can't make a sandbox
// fails rather than run the task's commands on the machine; the service won't start on the local runner
// without a sandbox unless the config allows it, for one tenant; and a jig a crashed service left running is
// stopped by the next one on the same machine. A shell script stands in for jig. No model is called.

const ROOT = join(import.meta.dirname, "..");
const SECRET = "the gateway's secret";
const KEY = "acme-key";
const TENANT: Tenant = { id: "acme", limits: { concurrency: 2, maxSteps: 50, timeLimit: 600, budgetUsd: null } };

const services: Service[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await removeTempDirs();
});

/** A fake jig: `sh <it> <file> <seconds> <jig's arguments>` writes the arguments to the file, a line each, and sleeps. */
async function fakeJig(dir: string): Promise<string> {
  const script = join(dir, "fake-jig.sh");
  await writeFile(script, 'out=$1; seconds=$2; shift 2\nprintf \'%s\\n\' "$@" > "$out"\nexec sleep "$seconds"\n');
  return script;
}

function task(id: string): Task {
  const now = new Date().toISOString();
  return { id, tenant: "acme", spec: { prompt: "hang", maxSteps: 50, timeLimit: 600, model: "claude-haiku-4-5" }, status: "running", exitCode: null, stop: null, error: null, created: now, started: now, ended: null, stats: null, usage: null, cost: null, result: null, resultTruncated: false, purged: null };
}

/** A local runner on `dataDir` whose jig writes its arguments to `out` and then sleeps `seconds`. */
const runner = (dataDir: string, script: string, out: string, seconds: number) =>
  new LocalRunner({ dataDir, jig: ["/bin/sh", script, out, String(seconds)], gatewayBaseUrl: "http://127.0.0.1:9/anthropic", gatewaySecret: SECRET, graceSeconds: 5 });

/** Whether any process is left in the group `pid` leads. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, "ESRCH");
    return false;
  }
}

describe("the local runner's sandbox", () => {
  it("runs jig with --sandbox, so a jig that can't make one fails rather than run the task's commands on the machine", async () => {
    const dir = await tempDir("jig-local-");
    const out = join(dir, "argv");
    const handle = await runner(join(dir, "data"), await fakeJig(dir), out, 0).start(task("task_sandboxed"), TENANT);
    assert.equal((await handle.wait()).exitCode, 0);
    const args = (await readFile(out, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 2), ["--sandbox", "--yes"]);
  });

  it("starts with local.allowUnsandboxed and one tenant, and then leaves jig to run without its sandbox where it has none", async () => {
    const dir = await tempDir("jig-local-");
    const out = join(dir, "argv");
    const config: Config = {
      port: 0,
      internal: { port: 0 },
      database: join(dir, "jig.db"),
      dataDir: join(dir, "data"),
      gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
      jig: ["/bin/sh", await fakeJig(dir), out, "0"],
      local: { allowUnsandboxed: true },
      tenants: [{ id: "acme", keys: [createHash("sha256").update(KEY).digest("hex")] }],
    };
    const lines: string[] = [];
    const service = await startService(config, { secret: SECRET, log: createLog("service", { format: "text", write: (line) => lines.push(line) }) });
    services.push(service);
    // The operator is told, sandbox or not.
    const warning = sandboxProblem() ? /^jig service: jig has no sandbox here \(.+\), so a local task's commands run directly on this machine/ : /^jig service: local\.allowUnsandboxed is set, so a local task whose jig can't make its sandbox .* runs its commands directly on this machine/;
    assert.ok(lines.some((line) => warning.test(line)), lines.join("\n"));
    const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    const { id } = await (await fetch(`${service.url}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ prompt: "hi" }) })).json();
    for (const deadline = Date.now() + 15_000; !(await (await fetch(`${service.url}/v1/tasks/${id}`, { headers })).json()).ended; ) {
      assert.ok(Date.now() < deadline, "the task ends");
      await new Promise((done) => setTimeout(done, 20));
    }
    const args = (await readFile(out, "utf8")).trim().split("\n");
    assert.equal(args[0], "--yes");
    assert.ok(!args.includes("--sandbox"));
  });

  it("refuses local.allowUnsandboxed that isn't true or false, or with more than one tenant on the local runner", () => {
    const base: Config = { database: ":memory:", dataDir: "data", gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [{ id: "acme", keys: [] }] };
    assert.throws(() => checkConfig({ ...base, local: { allowUnsandboxed: "yes" as never } }), /^Error: The config's local\.allowUnsandboxed must be true or false$/);
    assert.throws(() => checkConfig({ ...base, local: { allowUnsandboxed: true }, tenants: [{ id: "acme", keys: [] }, { id: "globex", keys: [] }] }), /The config's local\.allowUnsandboxed needs a single tenant/);
    checkConfig({ ...base, local: { allowUnsandboxed: true } });
    checkConfig({ ...base, local: { allowUnsandboxed: false }, tenants: [{ id: "acme", keys: [] }, { id: "globex", keys: [] }] });
    // The other runners don't read it.
    checkConfig({ ...base, runner: "kubernetes", kubernetes: { image: "jig-worker" }, local: { allowUnsandboxed: true }, tenants: [{ id: "acme", keys: [] }, { id: "globex", keys: [] }] });
  });

  // On macOS the sandbox is /usr/bin/sandbox-exec, which no PATH hides.
  describe("with no bubblewrap on the PATH", { skip: process.platform !== "linux" && "Linux's sandbox only is found on the PATH" }, () => {
    /** A folder for the PATH with only node, git and bash in it. */
    async function bareBin(dir: string): Promise<string> {
      const bin = join(dir, "bin");
      await mkdir(bin);
      for (const program of ["git", "bash"]) {
        const found = (process.env.PATH ?? "").split(delimiter).map((folder) => join(folder, program)).find((path) => existsSync(path));
        assert.ok(found, program);
        await symlink(found, join(bin, program));
      }
      await symlink(process.execPath, join(bin, "node"));
      return bin;
    }

    it("jig --sandbox --yes stops before it reaches the model, where without --sandbox it would go on", async () => {
      const dir = await tempDir("jig-local-");
      const project = join(dir, "project");
      await mkdir(project);
      const env = { PATH: await bareBin(dir), HOME: dir, JIG_HOME: join(dir, ".jig"), ANTHROPIC_API_KEY: "not a real key", NO_COLOR: "1" };
      const jig = (...flags: string[]) =>
        new Promise<{ code: number | null; output: string }>((done) => {
          const child = execFile(process.execPath, [join(ROOT, "src", "cli.ts"), ...flags, "--yes", "--model", "claude-haiku-4-5", "--base-url", "http://127.0.0.1:9", "-C", project, "-"], { env, timeout: 30_000 }, (err, stdout, stderr) =>
            done({ code: err ? ((err as { code?: number }).code ?? null) : 0, output: stdout + stderr }),
          );
          child.stdin!.end("run ls");
        });
      const sandboxed = await jig("--sandbox");
      assert.notEqual(sandboxed.code, 0);
      assert.match(sandboxed.output, /No sandbox: bubblewrap isn't installed/);
      assert.doesNotMatch(sandboxed.output, /couldn't be reached/);
      // What the local runner did before it passed --sandbox: jig says so, and goes on with --yes.
      const unsandboxed = await jig();
      assert.match(unsandboxed.output, /No sandbox: bubblewrap isn't installed[^]*couldn't be reached/);
    });

    it("the service refuses to start on the local runner, before it touches the database, unless local.allowUnsandboxed", async () => {
      const dir = await tempDir("jig-local-");
      const config: Config = { port: 0, internal: { port: 0 }, database: join(dir, "jig.db"), dataDir: join(dir, "data"), gatewayBaseUrl: "http://127.0.0.1:9/anthropic", tenants: [{ id: "acme", keys: [] }] };
      // In a node of its own, whose PATH has no bubblewrap: this one has looked for it already.
      const script = `const [api, config] = process.argv.slice(1);
        const { startService } = await import(api);
        try {
          const service = await startService(JSON.parse(config), { secret: "s" });
          console.log("started");
          await service.close();
        } catch (err) {
          console.log(err.message);
        }`;
      const start = (config: Config) =>
        new Promise<string>((done, fail) =>
          execFile(process.execPath, ["--input-type=module", "-e", script, pathToFileURL(join(ROOT, "server", "api.ts")).href, JSON.stringify(config)], { env: { PATH: join(dir, "none"), HOME: dir }, timeout: 30_000 }, (err, stdout) =>
            err ? fail(err) : done(stdout.trim()),
          ),
        );
      assert.match(await start(config), /^The local runner runs its tasks' commands in jig's sandbox, and there is none here: bubblewrap isn't installed/);
      assert.ok(!existsSync(config.database), "the database isn't made");
      assert.equal(await start({ ...config, local: { allowUnsandboxed: true } }), "started");
    });
  });
});

describe("the local runner's abandon", () => {
  it("records the run's process in run.json: its pid and host, and on Linux the boot and its start time", async () => {
    const dir = await tempDir("jig-local-");
    const local = runner(join(dir, "data"), await fakeJig(dir), join(dir, "argv"), 300);
    const handle = await local.start(task("task_recorded"), TENANT);
    stops.push(() => (handle.cancel(), handle.wait()));
    const run = JSON.parse(await readFile(join(local.dir("task_recorded"), "run.json"), "utf8"));
    assert.equal(run.host, hostname());
    assert.ok(Number.isInteger(run.pid) && groupAlive(run.pid));
    if (process.platform === "linux") {
      assert.equal(run.bootId, (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim());
      assert.ok(Number.isInteger(run.starttime));
    } else assert.deepEqual(Object.keys(run).sort(), ["host", "pid"]);
  });

  it("stops the jig a crashed service left running, but only the process it started", { skip: process.platform !== "linux" && "abandon finds the process by its /proc/<pid>/stat" }, async () => {
    const dir = await tempDir("jig-local-");
    const dataDir = join(dir, "data");
    const script = await fakeJig(dir);
    // The crashed service's run, its handle dropped with no cancel.
    const crashed = runner(dataDir, script, join(dir, "argv"), 300);
    const handle = await crashed.start(task("task_orphan"), TENANT);
    stops.push(() => (handle.cancel(), handle.wait()));
    const file = join(crashed.dir("task_orphan"), "run.json");
    const recorded = await readFile(file, "utf8");
    const { pid, starttime } = JSON.parse(recorded);
    assert.ok(groupAlive(pid));

    // The next service on the same machine and data directory.
    const next = runner(dataDir, script, join(dir, "argv"), 300);
    // Nothing recorded, nothing to stop.
    await next.abandon("task_none");
    // A process by the same pid but another start time isn't the one the run started: PID reuse.
    await writeFile(file, JSON.stringify({ ...JSON.parse(recorded), starttime: starttime + 1 }));
    await next.abandon("task_orphan");
    assert.ok(groupAlive(pid), "another start time leaves it running");
    await writeFile(file, JSON.stringify({ ...JSON.parse(recorded), host: `${hostname()}-not` }));
    await next.abandon("task_orphan");
    assert.ok(groupAlive(pid), "another host's run is left alone");
    // The same pid and start time, but counted from another boot: another process.
    await writeFile(file, JSON.stringify({ ...JSON.parse(recorded), bootId: "00000000-0000-0000-0000-000000000000" }));
    await next.abandon("task_orphan");
    assert.ok(groupAlive(pid), "another boot's run is left alone");

    await writeFile(file, recorded);
    await next.abandon("task_orphan");
    assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
    assert.equal((await handle.wait()).exitCode, null, "a signal ended it");
  });

  it("is what the service that ends a crashed one's task does with its run", { skip: process.platform !== "linux" && "abandon finds the process by its /proc/<pid>/stat" }, async () => {
    const dir = await tempDir("jig-local-");
    const [dataDir, database] = [join(dir, "data"), join(dir, "jig.db")];
    const script = await fakeJig(dir);
    // A service claims a task, starts its jig and crashes: its lease runs out.
    const store = await openStore(database);
    await store.putTenant(TENANT, [createHash("sha256").update(KEY).digest("hex")]);
    await store.createTask("acme", { prompt: "hang", maxSteps: 50, timeLimit: 600, model: "claude-haiku-4-5" });
    const claimed = await store.claim("acme", { owner: "the crashed service", leaseMs: 300, concurrency: 4, tenantConcurrency: 4 });
    assert.ok(typeof claimed === "object" && claimed);
    const crashed = runner(dataDir, script, join(dir, "argv"), 300);
    const handle = await crashed.start(claimed, TENANT);
    stops.push(() => (handle.cancel(), handle.wait()));
    const { pid } = JSON.parse(await readFile(join(crashed.dir(claimed.id), "run.json"), "utf8"));
    await store.close();
    await new Promise((done) => setTimeout(done, 350));

    const config: Config = { port: 0, internal: { port: 0 }, database, dataDir, keepTaskDirs: true, gatewayBaseUrl: "http://127.0.0.1:9/anthropic", leaseSeconds: 1, tenants: [{ id: "acme", keys: [] }] };
    const service = await startService(config, { secret: SECRET, runner: runner(dataDir, script, join(dir, "argv"), 300), log: createLog("service", { write: () => {} }) });
    services.push(service);
    // Ended in the service's first round of renewals, a third of a lease after it starts.
    for (const deadline = Date.now() + 15_000; (await service.store.task(claimed.id))!.status !== "error"; await new Promise((done) => setTimeout(done, 20))) assert.ok(Date.now() < deadline, "the task is ended");
    // Stopped as it is ended, though not waited for there.
    for (const deadline = Date.now() + 15_000; groupAlive(pid); await new Promise((done) => setTimeout(done, 20))) assert.ok(Date.now() < deadline, "the crashed service's jig is stopped");
    assert.equal((await handle.wait()).exitCode, null);
  });
});
