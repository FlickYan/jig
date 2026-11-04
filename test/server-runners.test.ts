import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Service, startService } from "../server/api.ts";
import { WarmPool } from "../server/pool.ts";
import type { Runner } from "../server/runner.ts";
import { DockerRunner } from "../server/runners/docker.ts";
import { KubernetesRunner, objectName, ROLE_LABELS, TASK_LABEL } from "../server/runners/k8s.ts";
import { Lines, lastLine, MAX_LINE, readStats, tail } from "../server/runners/local.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The Docker and Kubernetes runners (server/runners/), with a fake docker CLI (fixtures/fake-docker.mjs)
// and a fake Kubernetes API server, the worker a task's pod runs (server/worker.ts), and the deploy files.
// No docker, kubectl or model is run.

const FIXTURES = join(import.meta.dirname, "fixtures");
const FAKE_JIG = join(FIXTURES, "fake-jig.mjs");
const FAKE_DOCKER = join(FIXTURES, "fake-docker.mjs");
const WORKER = join(import.meta.dirname, "..", "server", "worker.ts");
const DEPLOY = join(import.meta.dirname, "..", "deploy");
const SECRET = "the gateway's secret";
const KEY = "acme-key";
// Stands in for the provider keys the service's environment may hold, which no task may get.
const REAL = { ANTHROPIC_API_KEY: "sk-ant-the-real-one", DEEPSEEK_API_KEY: "sk-the-real-deepseek-one" };

const services: Service[] = [];
const servers: { close(): Promise<void> }[] = [];
const saved = { ...process.env };
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const name of Object.keys(REAL)) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  await removeTempDirs();
});

/** The service with the given runner and one tenant, acme, with its key. It keeps the task folders, which the tests look in. */
async function service(runner: Runner): Promise<Service> {
  const base = await tempDir("jig-runners-");
  const started = await startService(
    { port: 0, internal: { port: 0 }, database: join(base, "jig.db"), dataDir: join(base, "data"), keepTaskDirs: true, gatewayBaseUrl: "http://gateway:8081/anthropic", graceSeconds: 5, tenants: [{ id: "acme", keys: [createHash("sha256").update(KEY).digest("hex")], budgetUsd: 2.5 }] },
    { secret: SECRET, runner },
  );
  services.push(started);
  return started;
}

async function call(service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
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

const ended = (service: Service, id: string) =>
  until(async () => {
    const { body } = await call(service, "GET", `/v1/tasks/${id}`);
    return body.ended && body;
  }, `task ${id} to end`);

/** The token contract's check, as the gateway makes it: the payload of a token the secret signed. */
function payloadOf(token: string): Record<string, unknown> {
  const [, body, mac] = /^(jgt1\.[\w-]+)\.([\w-]+)$/.exec(token) ?? [];
  assert.ok(body && timingSafeEqual(Buffer.from(mac, "base64url"), createHmac("sha256", SECRET).update(body).digest()), "the token verifies");
  return JSON.parse(Buffer.from(body.slice("jgt1.".length), "base64url").toString());
}

/** Every value that follows `flag` in a command line. */
const values = (args: string[], flag: string) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Docker runner", () => {
  /** The service on the Docker runner, with the fake docker's state files (`files`) there before it starts. */
  async function docker(config: Partial<ConstructorParameters<typeof DockerRunner>[0]> = {}, files: Record<string, string> = {}) {
    const base = await tempDir("jig-docker-");
    const state = join(base, "state");
    await mkdir(state);
    for (const [name, text] of Object.entries(files)) await writeFile(join(state, name), text);
    const runner = new DockerRunner({ dataDir: join(base, "data"), docker: [process.execPath, FAKE_DOCKER, state], image: "jig-worker:test", network: "jig-tasks", gatewayBaseUrl: "http://gateway:8081/anthropic", gatewaySecret: SECRET, graceSeconds: 5, pollMs: 20, ...config });
    const api = await service(runner);
    return { api, state, runner, dir: (id: string) => runner.dir(id), container: async (id: string) => JSON.parse(await readFile(join(state, `jig-${id}.json`), "utf8")) };
  }

  it("runs jig in a container with limits, no capabilities and the gateway's network, with the task's token and no real key", async () => {
    Object.assign(process.env, REAL);
    const { api, dir, container } = await docker({ runtime: "runsc", cpus: 2, memory: "3g", pidsLimit: 256, tmpSize: "64m" });
    const created = await call(api, "POST", "/v1/tasks", { prompt: "the task, on stdin", model: "claude-haiku-4-5", timeLimit: 600, workspace: { files: { "app.py": "print(1)\n" } } });
    const id = created.body.id;
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.exitCode], ["succeeded", "end_turn", 0]);

    const { args, env, image, program } = await container(id);
    for (const flag of ["--rm", "--interactive", "--init", "--read-only"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual(values(args, "--name"), [`jig-${id}`]);
    assert.deepEqual(values(args, "--cpus"), ["2"]);
    assert.deepEqual(values(args, "--memory"), ["3g"]);
    assert.deepEqual(values(args, "--memory-swap"), ["3g"], "no swap beyond the memory");
    assert.deepEqual(values(args, "--pids-limit"), ["256"]);
    assert.deepEqual(values(args, "--tmpfs"), ["/tmp:rw,nosuid,nodev,size=64m"]);
    assert.deepEqual(values(args, "--mount"), [`type=bind,source=${dir(id)},target=/task`]);
    assert.deepEqual(values(args, "--cap-drop"), ["ALL"]);
    assert.deepEqual(values(args, "--cap-add"), []);
    assert.ok(!args.includes("--privileged"));
    assert.deepEqual(values(args, "--security-opt"), ["no-new-privileges"]);
    assert.deepEqual(values(args, "--runtime"), ["runsc"]);
    assert.deepEqual(values(args, "--network"), ["jig-tasks"]);
    assert.deepEqual(values(args, "--user"), ["10001:10001"]);
    assert.deepEqual(values(args, "--env"), ["HOME=/task/home", "JIG_HOME=/task/home/.jig", "NO_COLOR=1", "ANTHROPIC_API_KEY"]);
    assert.equal(image, "jig-worker:test");
    assert.equal(program, "jig");
    const command = args.slice(args.indexOf(image) + 2);
    assert.deepEqual(command, ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--base-url", "http://gateway:8081/anthropic", "--max-steps", "50", "--time-limit", "600", "--events", "/task/events.jsonl", "--stats", "/task/stats.json", "-C", "/task/work", "-"]);
    assert.ok(!args.join(" ").includes("the task, on stdin"), "the task stays out of the process list");

    // The token, by name: its value is in the CLI's environment, which holds no real key.
    const payload = payloadOf(env.ANTHROPIC_API_KEY);
    assert.deepEqual([payload.tenant, payload.task, payload.budgetUsd], ["acme", id, 2.5]);
    for (const name of ["DEEPSEEK_API_KEY", "JIG_GATEWAY_SECRET"]) assert.equal(env[name], undefined, name);
    const everything = JSON.stringify(await container(id));
    for (const value of [...Object.values(REAL), SECRET]) assert.ok(!everything.includes(value), "no real key nor the gateway's secret reaches docker");

    // The events, read from the task's folder as jig wrote them in the container, are in the store.
    const written = (await readFile(join(dir(id), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(written.map((event) => event.type), ["start", "tool_call", "tool_result", "step", "text", "step", "end"]);
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), written);
    assert.deepEqual(task.stats, { stop: "end_turn", steps: 2 });
    assert.equal(await readFile(join(dir(id), "work", "app.py"), "utf8"), "print(1)\n");
    // A service running as root gives the folder to the container's user.
    if (process.getuid?.() === 0) assert.equal((await stat(join(dir(id), "work"))).uid, 10001);
  });

  it("runs a task with approvals in its mode, asking at the internal listener as the containers reach it", async () => {
    const { api, container } = await docker({ internalBaseUrl: "http://api:8082/" });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "exit 0", approvals: true, mode: "ask", timeLimit: 600 })).body.id;
    assert.equal((await ended(api, id)).status, "succeeded");
    const { args, image } = await container(id);
    const command = args.slice(args.indexOf(image) + 2);
    assert.deepEqual(command.slice(0, 7), ["--no-sandbox", "--mode", "ask", "--approve-via", "http://api:8082/internal/approvals", "--approval-timeout", "600"]);
    assert.ok(!command.includes("--yes"));
  });

  it("cancels with docker kill, which ends everything in the container, and stops a run past its time limit", async () => {
    const { api, state, dir } = await docker({ graceSeconds: 0 });
    const record = (id: string) => until(async () => JSON.parse(await readFile(join(dir(id), "work", ".fake-jig.json"), "utf8").catch(() => "null")), "the fake jig's record");
    const kills = async () => (await readFile(join(state, "kills.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    const cancelled = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    const first = await record(cancelled);
    assert.ok(alive(first.pid) && alive(first.child));
    assert.equal((await call(api, "POST", `/v1/tasks/${cancelled}/cancel`)).status, 202);
    assert.equal((await ended(api, cancelled)).status, "cancelled");
    assert.deepEqual(await kills(), [{ signal: "TERM", name: `jig-${cancelled}` }]);
    await until(() => !alive(first.pid) && !alive(first.child), "the container's processes to be gone");
    // What it wrote before the kill is in the store.
    assert.deepEqual((await api.store.events(cancelled)).map(({ event }) => (event as { type: string }).type), ["start", "tool_call", "tool_result", "step"]);

    const late = (await call(api, "POST", "/v1/tasks", { prompt: "hang", timeLimit: 1 })).body.id;
    const second = await record(late);
    const task = await ended(api, late);
    assert.deepEqual([task.status, task.stop], ["stopped", "time_limit"]);
    assert.deepEqual((await kills()).at(-1), { signal: "TERM", name: `jig-${late}` });
    await until(() => !alive(second.pid) && !alive(second.child), "the container's processes to be gone");
  });

  it("sends a cancel again until the container exists, and KILL after it while the run goes on", async () => {
    const { api, state, dir } = await docker();
    // The container exists 1.5 seconds after docker run starts, and its jig ignores TERM.
    await writeFile(join(state, "delay"), "1500");
    await writeFile(join(state, "deaf"), "");
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    await until(() => existsSync(join(state, `jig-${id}.json`)), "docker run");
    assert.equal((await call(api, "POST", `/v1/tasks/${id}/cancel`)).status, 202);
    assert.equal((await ended(api, id)).status, "cancelled");
    const signals = (await readFile(join(state, "kills.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).signal);
    const first = signals.indexOf("KILL");
    assert.ok(first >= 2 && signals.slice(0, first).every((signal) => signal === "TERM"), `TERM that missed, sent again: ${signals}`);
    assert.ok(signals.slice(first).every((signal) => signal === "KILL"));
    const { pid, child } = JSON.parse(await readFile(join(dir(id), "work", ".fake-jig.json"), "utf8"));
    await until(() => !alive(pid) && !alive(child), "the container's processes to be gone");
  });

  /** The containers the fake docker ran, as it recorded them, by name. */
  const runs = async (state: string) => {
    const names = (await readdir(state)).filter((name) => /^jig-.*\.json$/.test(name)).sort();
    return new Map(await Promise.all(names.map(async (name) => [name.slice(0, -".json".length), JSON.parse(await readFile(join(state, name), "utf8"))] as const)));
  };
  const kills = async (state: string) => (await readFile(join(state, "kills.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const pidOf = async (state: string, name: string) => Number(await readFile(join(state, `${name}.pid`), "utf8"));

  it("gives a task to a warm worker, whose jig starts without a docker run, well before a container could start", async () => {
    Object.assign(process.env, REAL);
    // A container takes 4 seconds to exist (its image being pulled, say): the warm one did so before the task came.
    const { api, state, runner, dir } = await docker({ pool: { size: 1 }, runtime: "runsc", cpus: 2, memory: "3g" }, { delay: "4000" });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const [[name, warm]] = [...(await runs(state))];
    assert.match(name, /^jig-pool_[0-9a-f]{24}$/);

    const posted = Date.now();
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "the task, in the claim's answer", model: "claude-haiku-4-5", timeLimit: 600, workspace: { files: { "app.py": "print(1)\n" } } })).body.id;
    await until(async () => (await api.store.events(id)).length > 0, "the task's first event");
    const waited = Date.now() - posted;
    assert.ok(waited < 2000, `its jig started ${waited} ms after it was posted`);
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.exitCode], ["succeeded", "end_turn", 0]);
    assert.equal(runner.pool!.stats().hits, 1);

    // No docker run for the task: it ran in the warm container, with its folder at /task.
    assert.ok(!(await runs(state)).has(`jig-${id}`));
    assert.deepEqual(values(warm.args, "--mount"), [`type=bind,source=${dir(id)},target=/task`]);
    // With the isolation a cold container gets, the ticket by name in its environment, and no key.
    const { args, image, program } = warm;
    for (const flag of ["--rm", "--init", "--read-only"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual([values(args, "--cpus"), values(args, "--memory"), values(args, "--memory-swap"), values(args, "--pids-limit")], [["2"], ["3g"], ["3g"], ["512"]]);
    assert.deepEqual([values(args, "--cap-drop"), values(args, "--security-opt"), values(args, "--runtime"), values(args, "--network"), values(args, "--user")], [["ALL"], ["no-new-privileges"], ["runsc"], ["jig-tasks"], ["10001:10001"]]);
    assert.deepEqual(values(args, "--tmpfs"), ["/tmp:rw,nosuid,nodev,size=512m"]);
    assert.deepEqual(values(args, "--env"), ["HOME=/task/home", "JIG_HOME=/task/home/.jig", "NO_COLOR=1", "JIG_POOL_TICKET"]);
    assert.deepEqual([image, program, ...args.slice(args.indexOf(image) + 2)], ["jig-worker:test", "node", "/opt/jig/server/worker.ts", "--pool", api.internalUrl]);
    assert.match(warm.env.JIG_POOL_TICKET, /^[\w-]{43}$/, "32 random bytes");
    for (const value of [...Object.values(REAL), SECRET]) assert.ok(!JSON.stringify(warm).includes(value), "no real key nor the gateway's secret reaches docker");

    // Its jig got the task, the workspace and the task's token, and not the ticket.
    const jig = JSON.parse(await readFile(join(dir(id), "work", ".fake-jig.json"), "utf8"));
    assert.equal(jig.task, "the task, in the claim's answer");
    assert.equal(jig.env.JIG_POOL_TICKET, undefined);
    const payload = payloadOf(jig.env.ANTHROPIC_API_KEY);
    assert.deepEqual([payload.tenant, payload.task, payload.budgetUsd], ["acme", id, 2.5]);
    assert.deepEqual(jig.args.slice(0, 4), ["--no-sandbox", "--yes", "--model", "claude-haiku-4-5"]);
    assert.equal(await readFile(join(dir(id), "work", "app.py"), "utf8"), "print(1)\n");
    const written = (await readFile(join(dir(id), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), written);
    assert.deepEqual(task.stats, { stop: "end_turn", steps: 2 });

    // The ticket was spent at the claim.
    const again = await fetch(`${api.internalUrl}/internal/pool/claim`, { method: "POST", headers: { authorization: `Bearer ${warm.env.JIG_POOL_TICKET}` } });
    assert.equal(again.status, 401);
    // Another worker was started in its place.
    await until(async () => (await runs(state)).size === 2, "a worker in its place");
  });

  it("starts a task cold when no warm worker waits, and fills the pool behind it", async () => {
    const { api, state, runner } = await docker({ pool: { size: 1 } }, { delay: "1000" });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    assert.equal((await ended(api, id)).status, "succeeded");
    assert.ok((await runs(state)).has(`jig-${id}`), "its own docker run");
    await until(() => runner.pool!.stats().idle === 1, "the warm worker started meanwhile");
    assert.deepEqual([runner.pool!.stats().hits, runner.pool!.stats().misses], [0, 1]);
  });

  it("cancels a task on a warm worker with docker kill, which ends everything in its container", async () => {
    const { api, state, runner, dir } = await docker({ pool: { size: 1 } });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const [name] = [...(await runs(state)).keys()];
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    const record = await until(async () => JSON.parse(await readFile(join(dir(id), "work", ".fake-jig.json"), "utf8").catch(() => "null")), "the fake jig's record");
    const worker = await pidOf(state, name);
    assert.ok(alive(worker) && alive(record.pid) && alive(record.child));
    assert.equal((await call(api, "POST", `/v1/tasks/${id}/cancel`)).status, 202);
    assert.equal((await ended(api, id)).status, "cancelled");
    assert.deepEqual((await kills(state)).filter((kill) => kill.name === name), [{ signal: "TERM", name }]);
    await until(() => ![worker, record.pid, record.child].some(alive), "the container's processes to be gone");
  });

  it("replaces a worker idle past maxIdleSeconds", async () => {
    const { state, runner } = await docker({ pool: { size: 1, maxIdleSeconds: 1 } });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const [first] = [...(await runs(state)).keys()];
    const pid = await pidOf(state, first);
    // Its claim is answered 410, and docker kill sent, a second after it started; another takes its place.
    await until(async () => (await runs(state)).size >= 2, "a worker in its place");
    await until(() => !alive(pid), "the first worker to be gone");
    assert.ok((await kills(state)).some((kill) => kill.name === first && kill.signal === "TERM"));
    await until(() => runner.pool!.stats().idle === 1, "the new one waiting");
  });

  it("stops the idle workers as the service stops, and starts no more", async () => {
    const { api, state, runner } = await docker({ pool: { size: 2 } });
    await until(() => runner.pool!.stats().idle === 2, "two warm workers");
    const idle = [...(await runs(state)).keys()];
    const pids = await Promise.all(idle.map((name) => pidOf(state, name)));
    services.splice(services.indexOf(api), 1);
    await api.close();
    // Their folders are gone by then: a process that exits once the service has closed leaves none behind.
    assert.deepEqual(await readdir(join(runner.dir("none"), "..")), []);
    // Told so in the answer to their claims, and sent docker kill.
    await until(() => !pids.some(alive), "the idle workers to be gone");
    await until(async () => (await kills(state)).length === 2, "the kills");
    assert.deepEqual((await kills(state)).map((kill) => kill.name).sort(), idle);
    assert.equal(runner.pool!.stats().idle, 0);
    await new Promise((done) => setTimeout(done, 200));
    assert.deepEqual([...(await runs(state)).keys()], idle);
  });

  it("leaves out an event too long to read, without holding it, and the run goes on, counted, until stopped", async () => {
    // A task's commands can write the events file; a line with no end would fill the service's memory.
    const { api, state } = await docker();
    await writeFile(join(state, "flood"), String(MAX_LINE + 1));
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    await until(async () => (await api.store.events(id)).length === 4, "the events after it");
    assert.deepEqual((await api.store.events(id)).map(({ event }) => (event as { type: string }).type), ["start", "tool_call", "tool_result", "step"]);
    assert.equal((await call(api, "GET", `/v1/tasks/${id}`)).body.status, "running");
    assert.equal(api.scheduler.running("acme"), 1);
    assert.equal((await call(api, "POST", `/v1/tasks/${id}/cancel`)).status, 202);
    assert.equal((await ended(api, id)).status, "cancelled");
  });

  it("cuts the events file into lines across reads, whatever their characters, and skips one over the limit", async () => {
    const dir = await tempDir("jig-docker-");
    const file = join(dir, "events.jsonl");
    const event = (seq: number, text: string) => `${JSON.stringify({ v: 1, seq, ts: "", type: "text", text })}\n`;
    // Wider than a read, with characters of two and four bytes across where reads end.
    const wide = "é😀".repeat(30_000);
    await writeFile(file, event(1, wide) + event(2, "x".repeat(MAX_LINE)) + "y".repeat(3 * MAX_LINE));
    let done = false;
    const seen: unknown[] = [];
    const reading = (async () => {
      for await (const { seq, text } of tail(file, () => done, 10)) seen.push([seq, text]);
    })();
    await until(() => seen.length === 1, "the first event");
    // The long line ends later; what follows it is read, and a last line with no newline isn't.
    await writeFile(file, `\n${event(3, "after")}{"v":1,`, { flag: "a" });
    await until(() => seen.length === 2, "the event after the long line");
    done = true;
    await reading;
    assert.deepEqual(seen, [[1, wide], [3, "after"]]);
    // The same cut for a stream of chunks, its last line kept.
    const lines = new Lines();
    const bytes = Buffer.from(`a${wide}\n${"z".repeat(MAX_LINE + 1)}\nb\nc`);
    const out = [];
    for (let i = 0; i < bytes.length; i += 1000) out.push(...lines.push(bytes.subarray(i, i + 1000)));
    assert.deepEqual([...out, lines.end()], [`a${wide}`, "b", "c"]);
  });

  it("reads the run's files only where they are regular files, not links or pipes a task's commands left", async () => {
    // jig runs without its sandbox in a container, so its commands can replace anything in /task.
    const dir = await tempDir("jig-docker-");
    const service = join(dir, "the-service's");
    await writeFile(service, `${JSON.stringify({ v: 1, seq: 1, ts: "", type: "start", secret: "another tenant's" })}\n`);
    for (const name of ["events.jsonl", "stats.json", "output.log"]) await symlink(service, join(dir, name));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    assert.equal(await readStats(join(dir, "stats.json")), undefined);
    assert.equal(await lastLine(join(dir, "output.log")), undefined);
    assert.equal(await readStats(join(dir, "pipe")), undefined);
    const events = [];
    for await (const event of tail(join(dir, "events.jsonl"), () => true, 10)) events.push(event);
    assert.deepEqual(events, []);
    // The same files, as files, are read.
    assert.equal(await lastLine(service), (await readFile(service, "utf8")).trim());
  });
});

/** What a fake pod does: the lines it logs, then how it ends; or it waits to be deleted; or never starts. */
interface Script {
  lines?: string[];
  exitCode?: number;
  reason?: string;
  /** The Job's condition's reason, if not the one its end gives. */
  jobReason?: string;
  hold?: boolean;
  pending?: { reason: string; message: string };
}

interface Pod {
  name: string;
  job: string;
  script: Script;
  status: object;
  logs: ServerResponse[];
  /** A warm worker's: settles once its claim is answered, the script then its task's. */
  claimed?: Promise<void>;
}

/**
 * A Kubernetes API server, over TLS, with the few routes the runner uses and pods that do as scripted. A
 * warm worker's pod (its command has --pool <url>) claims its task there with the ticket in its Secret, as
 * server/worker.ts does, and then does as the task's script says; refused, it exits.
 */
class FakeCluster {
  url = "";
  token = "the service account's token";
  namespace = "jig";
  requests: { method: string; path: string; auth?: string; type?: string; body?: any }[] = [];
  /** The warm workers' claims: how each was answered. */
  claims: { job: string; status?: number; answer?: any }[] = [];
  jobs = new Map<string, any>();
  secrets = new Map<string, any>();
  pods = new Map<string, Pod>();
  /** What the pod of a task with this prompt does. */
  script: (prompt: string) => Script = () => ({ lines: [] });
  private server!: Server;

  static async start(): Promise<FakeCluster> {
    const cluster = new FakeCluster();
    cluster.server = createServer({ key: await readFile(join(FIXTURES, "k8s-api.key")), cert: await readFile(join(FIXTURES, "k8s-api.crt")) }, (req, res) => void cluster.handle(req, res));
    await new Promise<void>((done) => cluster.server.listen(0, "127.0.0.1", done));
    cluster.url = `https://127.0.0.1:${(cluster.server.address() as AddressInfo).port}`;
    servers.push({ close: () => new Promise((done) => (cluster.server.closeAllConnections(), cluster.server.close(() => done()))) });
    return cluster;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let text = "";
    for await (const chunk of req) text += chunk;
    const url = new URL(req.url!, "https://cluster");
    const body = text ? JSON.parse(text) : undefined;
    this.requests.push({ method: req.method!, path: url.pathname + url.search, auth: req.headers.authorization, type: req.headers["content-type"], body });
    const reply = (status: number, value: object) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const missing = () => reply(404, { kind: "Status", message: "not found", code: 404 });
    if (req.headers.authorization !== `Bearer ${this.token}`) return reply(401, { kind: "Status", message: "Unauthorized", code: 401 });
    const ns = `/namespaces/${this.namespace}/`;
    // The API server's rule for a Job's or a Secret's name (a DNS-1123 subdomain), and the 63 characters a
    // label takes, which the Job's name goes into.
    const name = body?.metadata?.name;
    if (req.method === "POST" && !(typeof name === "string" && name.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name))) return reply(422, { kind: "Status", message: `invalid name: ${name}`, code: 422 });
    let match;
    if (req.method === "POST" && url.pathname === `/apis/batch/v1${ns}jobs`) {
      const job = { ...body, metadata: { ...body.metadata, uid: randomUUID() }, status: {} };
      this.jobs.set(job.metadata.name, job);
      return reply(201, job);
    }
    if (req.method === "POST" && url.pathname === `/api/v1${ns}secrets`) {
      this.secrets.set(body.metadata.name, body);
      // A warm worker's pod starts, and claims, before anyone looks for it.
      const job = this.jobs.get(body.metadata.name);
      if (job?.spec.template.spec.containers[0].command.includes("--pool")) this.pod(job);
      return reply(201, body);
    }
    if ((match = new RegExp(`^/apis/batch/v1${ns}jobs/([\\w-]+)$`).exec(url.pathname))) {
      const job = this.jobs.get(match[1]);
      if (!job) return missing();
      if (req.method === "GET") return reply(200, job);
      if (req.method === "PATCH") {
        if (req.headers["content-type"] !== "application/merge-patch+json") return reply(415, { kind: "Status", message: "a merge patch, here", code: 415 });
        Object.assign(job.metadata.labels, body.metadata?.labels);
        Object.assign(job.spec, body.spec);
        return reply(200, job);
      }
      if (req.method === "DELETE") {
        this.jobs.delete(match[1]);
        for (const [name, pod] of this.pods) {
          if (pod.job !== match[1]) continue;
          this.pods.delete(name);
          for (const log of pod.logs) log.end();
        }
        return reply(200, { kind: "Status", status: "Success" });
      }
    }
    if (req.method === "GET" && url.pathname === `/api/v1${ns}pods`) {
      const [key, value] = url.searchParams.get("labelSelector")!.split("=");
      const items = [...this.jobs.values()].filter((job) => job.spec.template.metadata.labels[key] === value).map((job) => this.pod(job)).filter((pod) => pod !== undefined);
      return reply(200, { kind: "PodList", items: items.map((pod) => ({ metadata: { name: pod.name }, status: pod.status })) });
    }
    if (req.method === "GET" && (match = new RegExp(`^/api/v1${ns}pods/([\\w-]+)(/log)?$`).exec(url.pathname))) {
      const pod = this.pods.get(match[1]);
      if (!pod) return missing();
      if (!match[2]) return reply(200, { metadata: { name: pod.name }, status: pod.status });
      assert.equal(url.searchParams.get("follow"), "true");
      await pod.claimed;
      res.writeHead(200, { "content-type": "text/plain" });
      for (const line of pod.script.lines ?? []) res.write(`${line}\n`);
      if (pod.script.hold) return void pod.logs.push(res);
      this.end(pod);
      return void res.end();
    }
    reply(404, { kind: "Status", message: `no route ${req.method} ${url.pathname}`, code: 404 });
  }

  /** The Job's pod: made once its Secret is there, as the kubelet can mount it only then. */
  private pod(job: any): Pod | undefined {
    const name = `${job.metadata.name}-x7k2p`;
    const secret = this.secrets.get(job.metadata.name);
    if (!this.pods.has(name) && secret) {
      const command: string[] = job.spec.template.spec.containers[0].command;
      const pool = command.indexOf("--pool");
      const script = pool === -1 ? this.script(JSON.parse(secret.stringData["task.json"]).prompt) : {};
      const pod: Pod = { name, job: job.metadata.name, script, logs: [], status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] } };
      this.pods.set(name, pod);
      if (pool !== -1) pod.claimed = this.claim(pod, command[pool + 1], secret.stringData.ticket);
      // A pod that never starts, which the Job's deadline ends.
      if (script.pending) {
        pod.status = { phase: "Pending", containerStatuses: [{ state: { waiting: script.pending } }] };
        job.status = { conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded", message: "Job was active longer than specified deadline" }] };
      }
    }
    return this.pods.get(name);
  }

  /** A warm worker's claim, with the ticket its Secret gave it. */
  private async claim(pod: Pod, url: string, ticket: string): Promise<void> {
    const res = await fetch(`${url}/internal/pool/claim`, { method: "POST", headers: { authorization: `Bearer ${ticket}` } }).catch(() => undefined);
    const answer = res?.status === 200 ? await res.json() : undefined;
    await res?.body?.cancel().catch(() => {});
    this.claims.push({ job: pod.job, status: res?.status, answer });
    if (answer) pod.script = this.script(answer.prompt);
    else this.end(pod);
  }

  private end(pod: Pod): void {
    const { exitCode = 0, reason, jobReason } = pod.script;
    pod.status = { phase: exitCode ? "Failed" : "Succeeded", containerStatuses: [{ state: { terminated: { exitCode, reason: reason ?? (exitCode ? "Error" : "Completed") } } }] };
    const job = this.jobs.get(pod.job);
    if (!job) return;
    job.status = { conditions: [{ type: exitCode ? "Failed" : "Complete", status: "True", ...((jobReason ?? exitCode) ? { reason: jobReason ?? "BackoffLimitExceeded" } : {}) }] };
  }
}

/** What jig with --events - and the worker after it print, for a run that ends with `stop`, among jig's terminal output. */
function logOf(code: number | undefined, stop: string | undefined): string[] {
  const event = (seq: number, type: string, fields: object) => JSON.stringify({ v: 1, seq, ts: new Date().toISOString(), type, ...fields });
  const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
  return [
    event(1, "start", { task: "x", cwd: "/task/work", model: "claude-haiku-4-5", version: "0.1.0", limits: { maxSteps: 50, timeLimit: 600 } }),
    "› bash ls",
    event(2, "tool_call", { step: 1, id: "call_1", name: "bash", description: "ls" }),
    event(3, "step", { step: 1, usage, cost: 0.001 }),
    ...(stop ? [event(4, "end", { stop, exitCode: code, steps: 1, usage, cost: 0.001, seconds: 1 })] : []),
    ...(code === undefined ? [] : [JSON.stringify({ jigWorker: 1, exitCode: code, stats: { stop, steps: 1 } })]),
  ];
}

describe("the Kubernetes runner", () => {
  async function kubernetes(config: Partial<ConstructorParameters<typeof KubernetesRunner>[0]> = {}) {
    const cluster = await FakeCluster.start();
    const base = await tempDir("jig-k8s-");
    const tokenFile = join(base, "token");
    await writeFile(tokenFile, `${cluster.token}\n`);
    const runner = new KubernetesRunner({ apiUrl: cluster.url, tokenFile, caFile: join(FIXTURES, "k8s-api.crt"), namespace: "jig", image: "registry.example.com/jig-worker:1", gatewayBaseUrl: "http://jig-gateway.jig.svc:8081/anthropic", gatewaySecret: SECRET, graceSeconds: 5, pollMs: 20, ...config });
    return { cluster, tokenFile, runner, api: await service(runner) };
  }

  it("sends a Job with the limits, the deadline, the ttl, the runtime class and a locked-down pod, the token in a Secret it owns", async () => {
    Object.assign(process.env, REAL);
    const resources = { requests: { cpu: "500m", memory: "1Gi" }, limits: { cpu: "2", memory: "3Gi", "ephemeral-storage": "2Gi" } };
    const { cluster, api } = await kubernetes({ runtimeClassName: "gvisor", ttlSecondsAfterFinished: 300, resources });
    const lines = logOf(0, "end_turn");
    cluster.script = () => ({ lines });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "the task, in the Secret", model: "claude-haiku-4-5", timeLimit: 600, workspace: { files: { "app.py": "print(1)\n" } } })).body.id;
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.exitCode], ["succeeded", "end_turn", 0]);

    const job = cluster.jobs.get(objectName(id));
    assert.deepEqual([job.apiVersion, job.kind, job.metadata.name], ["batch/v1", "Job", objectName(id)]);
    assert.match(job.metadata.name, /^jig-task-[0-9a-f]{32}$/, "a name the API server takes, from the task id");
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(job.spec.activeDeadlineSeconds, 605, "the time limit and the grace");
    assert.equal(job.spec.ttlSecondsAfterFinished, 300);
    const pod = job.spec.template.spec;
    assert.deepEqual(job.spec.template.metadata.labels, { ...ROLE_LABELS, [TASK_LABEL]: id, "jig.dev/tenant": "acme" });
    assert.equal(pod.restartPolicy, "Never");
    assert.equal(pod.runtimeClassName, "gvisor");
    assert.equal(pod.serviceAccountName, "jig-task");
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.enableServiceLinks, false);
    assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } });
    assert.equal(pod.containers.length, 1);
    const [container] = pod.containers;
    assert.equal(container.image, "registry.example.com/jig-worker:1");
    assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } });
    assert.deepEqual(container.resources, resources);
    assert.deepEqual(container.command, ["node", "/opt/jig/server/worker.ts", "/task-input/task.json", "jig", "--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--base-url", "http://jig-gateway.jig.svc:8081/anthropic", "--max-steps", "50", "--time-limit", "600", "--events", "-", "--stats", "/task/stats.json", "-C", "/task/work", "-"]);
    assert.deepEqual(container.env, [
      { name: "HOME", value: "/task/home" },
      { name: "JIG_HOME", value: "/task/home/.jig" },
      { name: "NO_COLOR", value: "1" },
      { name: "ANTHROPIC_API_KEY", valueFrom: { secretKeyRef: { name: objectName(id), key: "token" } } },
    ]);
    assert.ok(!JSON.stringify(job).includes("the task, in the Secret"), "the task is in the Secret, not the Job");

    // The Secret: deleted with the Job, the token for this task, and the task.
    const secret = cluster.secrets.get(objectName(id));
    assert.deepEqual(secret.metadata.ownerReferences, [{ apiVersion: "batch/v1", kind: "Job", name: objectName(id), uid: job.metadata.uid }]);
    const payload = payloadOf(secret.stringData.token);
    assert.deepEqual([payload.tenant, payload.task, payload.budgetUsd], ["acme", id, 2.5]);
    assert.deepEqual(JSON.parse(secret.stringData["task.json"]), { prompt: "the task, in the Secret", workspace: { files: { "app.py": "print(1)\n" } }, gitProtocols: ["https"], work: "/task/work", stats: "/task/stats.json" });
    const sent = JSON.stringify(cluster.requests);
    for (const value of [...Object.values(REAL), SECRET]) assert.ok(!sent.includes(value), "no real key nor the gateway's secret reaches the cluster");
    // Every request had the token from the file, over TLS checked against the CA from its file.
    assert.ok(cluster.requests.every((request) => request.auth === `Bearer ${cluster.token}`));

    // The events from the pod's log, jig's other output and the worker's line left out; the stats from that line.
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), lines.slice(0, -1).filter((line) => !line.startsWith("›")).map((line) => JSON.parse(line)));
    assert.deepEqual(task.stats, { stop: "end_turn", steps: 1 });
  });

  it("passes a task with approvals the flags that ask at the internal listener's Service", async () => {
    const { cluster, api } = await kubernetes({ internalBaseUrl: "http://jig-api-internal.jig.svc:8082" });
    cluster.script = () => ({ lines: logOf(0, "end_turn") });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "x", approvals: true, model: "claude-haiku-4-5", timeLimit: 600 })).body.id;
    assert.equal((await ended(api, id)).status, "succeeded");
    const [container] = cluster.jobs.get(objectName(id)).spec.template.spec.containers;
    assert.deepEqual(container.command.slice(3, 12), ["jig", "--no-sandbox", "--mode", "edits", "--approve-via", "http://jig-api-internal.jig.svc:8082/internal/approvals", "--approval-timeout", "600", "--model"]);
  });

  it("maps how the pod and the Job ended, and the end event, to the task's status", async () => {
    const { cluster, api } = await kubernetes();
    const scripts: Record<string, Script> = {
      "max steps": { lines: logOf(2, "max_steps"), exitCode: 2 },
      refusal: { lines: logOf(4, "refusal"), exitCode: 4 },
      // jig's own failure, the last line it printed the reason.
      fails: { lines: [...logOf(undefined, undefined), "jig: the API refused the key", JSON.stringify({ jigWorker: 1, exitCode: 1 })], exitCode: 1 },
      "out of memory": { lines: logOf(undefined, undefined), exitCode: 137, reason: "OOMKilled" },
      // The Job's deadline: jig got SIGTERM and printed no end.
      deadline: { lines: logOf(undefined, undefined), exitCode: 143, jobReason: "DeadlineExceeded" },
      "never starts": { pending: { reason: "ImagePullBackOff", message: 'Back-off pulling image "registry.example.com/jig-worker:1"' } },
    };
    cluster.script = (prompt) => scripts[prompt];
    const ids = new Map<string, string>();
    for (const prompt of Object.keys(scripts)) ids.set(prompt, (await call(api, "POST", "/v1/tasks", { prompt })).body.id);
    const outcome = async (prompt: string) => {
      const task = await ended(api, ids.get(prompt)!);
      return [task.status, task.stop, task.exitCode, task.error];
    };
    assert.deepEqual(await outcome("max steps"), ["stopped", "max_steps", 2, null]);
    assert.deepEqual(await outcome("refusal"), ["failed", "refusal", 4, null]);
    assert.deepEqual(await outcome("fails"), ["error", "error", 1, "jig exited with 1: jig: the API refused the key"]);
    assert.deepEqual(await outcome("out of memory"), ["error", "error", 137, "jig exited with 137: it ran out of memory (OOMKilled): › bash ls"]);
    assert.deepEqual(await outcome("deadline"), ["stopped", "time_limit", 143, null]);
    const never = await outcome("never starts");
    assert.deepEqual(never.slice(0, 3), ["error", "error", null]);
    assert.match(never[3], /DeadlineExceeded: .* the pod was ImagePullBackOff: Back-off pulling image/);
  });

  it("leaves out a line of the pod's log too long to read", async () => {
    // The task's commands can write the log too, through /proc/1/fd/1.
    const { cluster, api } = await kubernetes();
    const lines = logOf(0, "end_turn");
    const long = JSON.stringify({ v: 1, seq: 2, ts: "", type: "text", text: "x".repeat(MAX_LINE) });
    cluster.script = () => ({ lines: [lines[0], long, ...lines.slice(1)] });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "flood" })).body.id;
    assert.equal((await ended(api, id)).status, "succeeded");
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), lines.slice(0, -1).filter((line) => !line.startsWith("›")).map((line) => JSON.parse(line)));
  });

  it("cancels by deleting the Job in the background, with a token read again from its file", async () => {
    const { cluster, tokenFile, api } = await kubernetes();
    cluster.script = () => ({ lines: logOf(undefined, undefined), hold: true });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    await until(async () => (await api.store.events(id)).length === 3, "the pod's events");
    assert.equal((await call(api, "GET", `/v1/tasks/${id}`)).body.status, "running");
    // The kubelet renews the token in the file.
    cluster.token = "the renewed token";
    await writeFile(tokenFile, cluster.token);
    assert.equal((await call(api, "POST", `/v1/tasks/${id}/cancel`)).status, 202);
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.error], ["cancelled", null]);
    const deletes = cluster.requests.filter((request) => request.method === "DELETE");
    assert.deepEqual(deletes.map(({ path, auth, body }) => [path, auth, body]), [[`/apis/batch/v1/namespaces/jig/jobs/${objectName(id)}?propagationPolicy=Background`, "Bearer the renewed token", { apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" }]]);
    assert.equal(cluster.jobs.size, 0);
  });

  it("gives a task to a warm worker's Job, its deadline moved to the task's, with no Job made for the task", async () => {
    Object.assign(process.env, REAL);
    const { cluster, runner, api } = await kubernetes({ pool: { size: 1, maxIdleSeconds: 300 }, runtimeClassName: "gvisor" });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const [[name, warm]] = [...cluster.jobs];
    assert.match(name, /^jig-pool-[0-9a-f]{16}$/);
    // A task's pod in all but its command, its ticket for the token, and no input mounted.
    assert.equal(warm.spec.activeDeadlineSeconds, 360, "the most it may wait, and a minute");
    assert.deepEqual(warm.spec.template.metadata.labels, { ...ROLE_LABELS, "jig.dev/pool": name.slice("jig-".length) });
    const pod = warm.spec.template.spec;
    assert.deepEqual([pod.runtimeClassName, pod.serviceAccountName, pod.automountServiceAccountToken, pod.enableServiceLinks], ["gvisor", "jig-task", false, false]);
    assert.deepEqual(pod.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } });
    const [container] = pod.containers;
    assert.deepEqual(container.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ["ALL"] } });
    assert.deepEqual(container.command, ["node", "/opt/jig/server/worker.ts", "--pool", api.internalUrl]);
    assert.deepEqual(container.env.at(-1), { name: "JIG_POOL_TICKET", valueFrom: { secretKeyRef: { name, key: "ticket" } } });
    assert.deepEqual(container.volumeMounts.map((mount: { name: string }) => mount.name), ["task", "tmp"]);
    const secret = cluster.secrets.get(name);
    assert.deepEqual(secret.metadata.ownerReferences, [{ apiVersion: "batch/v1", kind: "Job", name, uid: warm.metadata.uid }]);
    assert.deepEqual(Object.keys(secret.stringData), ["ticket"]);
    assert.match(secret.stringData.ticket, /^[\w-]{43}$/);

    const lines = logOf(0, "end_turn");
    cluster.script = () => ({ lines });
    const before = cluster.requests.length;
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "the task, in the claim's answer", model: "claude-haiku-4-5", timeLimit: 600, workspace: { files: { "app.py": "print(1)\n" } } })).body.id;
    const task = await ended(api, id);
    assert.deepEqual([task.status, task.stop, task.exitCode], ["succeeded", "end_turn", 0]);
    assert.equal(runner.pool!.stats().hits, 1);
    // No Job of its own: the warm one's deadline is the task's time limit and the grace, from now, and it has the task's labels.
    const since = cluster.requests.slice(before);
    const made = since.filter((request) => request.method === "POST" && request.path.endsWith("/jobs")).map((request) => request.body.metadata.name);
    assert.ok(made.every((job) => /^jig-pool-/.test(job)) && !cluster.jobs.has(objectName(id)), `Jobs made: ${made}`);
    const [patch, ...more] = since.filter((request) => request.method === "PATCH");
    assert.equal(more.length, 0);
    assert.deepEqual([patch.path, patch.type], [`/apis/batch/v1/namespaces/jig/jobs/${name}`, "application/merge-patch+json"]);
    assert.deepEqual(patch.body.metadata, { labels: { [TASK_LABEL]: id, "jig.dev/tenant": "acme" } });
    assert.ok(patch.body.spec.activeDeadlineSeconds >= 605 && patch.body.spec.activeDeadlineSeconds <= 610, String(patch.body.spec.activeDeadlineSeconds));

    // The claim's answer: what a cold task's Secret and command line hold.
    const [claim] = cluster.claims;
    assert.equal(claim.status, 200);
    const { env, ...rest } = claim.answer;
    assert.deepEqual(rest, {
      prompt: "the task, in the claim's answer",
      workspace: { files: { "app.py": "print(1)\n" } },
      gitProtocols: ["https"],
      work: "/task/work",
      stats: "/task/stats.json",
      command: ["jig", "--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "--base-url", "http://jig-gateway.jig.svc:8081/anthropic", "--max-steps", "50", "--time-limit", "600", "--events", "-", "--stats", "/task/stats.json", "-C", "/task/work", "-"],
      report: true,
    });
    const payload = payloadOf(env.ANTHROPIC_API_KEY);
    assert.deepEqual([payload.tenant, payload.task, payload.budgetUsd], ["acme", id, 2.5]);
    const sent = JSON.stringify(cluster.requests);
    for (const value of [...Object.values(REAL), SECRET]) assert.ok(!sent.includes(value), "no real key nor the gateway's secret reaches the cluster");
    // The events from the warm pod's log.
    assert.deepEqual((await api.store.events(id)).map(({ event }) => event), lines.slice(0, -1).filter((line) => !line.startsWith("›")).map((line) => JSON.parse(line)));
    assert.deepEqual(task.stats, { stop: "end_turn", steps: 1 });
  });

  it("cancels a task on a warm worker by deleting its Job, and deletes the idle ones' as the service stops", async () => {
    const { cluster, runner, api } = await kubernetes({ pool: { size: 1 } });
    await until(() => runner.pool!.stats().idle === 1, "a warm worker waiting for a task");
    const [name] = [...cluster.jobs.keys()];
    cluster.script = () => ({ lines: logOf(undefined, undefined), hold: true });
    const id = (await call(api, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    await until(async () => (await api.store.events(id)).length === 3, "the pod's events");
    assert.equal((await call(api, "POST", `/v1/tasks/${id}/cancel`)).status, 202);
    assert.equal((await ended(api, id)).status, "cancelled");
    const deletes = () => cluster.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    assert.deepEqual(deletes(), [`/apis/batch/v1/namespaces/jig/jobs/${name}?propagationPolicy=Background`]);

    await until(() => runner.pool!.stats().idle === 1, "the worker in its place");
    const [idle] = [...cluster.jobs.keys()];
    services.splice(services.indexOf(api), 1);
    await api.close();
    assert.deepEqual(deletes().at(-1), `/apis/batch/v1/namespaces/jig/jobs/${idle}?propagationPolicy=Background`);
    assert.equal(cluster.jobs.size, 0);
    // Its claim was answered as it was stopped.
    await until(() => cluster.claims.length === 2, "the idle worker's claim answered");
    assert.deepEqual(cluster.claims.map((claim) => claim.status), [200, 410]);
  });
});

describe("the worker a task's pod runs", () => {
  async function worker(input: object, dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    await writeFile(join(dir, "task.json"), JSON.stringify({ gitProtocols: ["https"], work: join(dir, "work"), stats: join(dir, "stats.json"), ...input }));
    const child = spawn(process.execPath, [WORKER, join(dir, "task.json"), process.execPath, FAKE_JIG, "--events", "-", "--stats", join(dir, "stats.json"), "-C", join(dir, "work"), "-"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    return { code, stdout, stderr };
  }

  it("makes the workspace, gives jig the task on stdin, and prints its exit and stats after the events", async () => {
    const dir = await tempDir("jig-worker-");
    const { code, stdout } = await worker({ prompt: "exit 2", workspace: { files: { "src/app.py": "print(1)\n" } } }, dir);
    assert.equal(code, 2);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.slice(0, -1).map((event) => event.type), ["start", "tool_call", "tool_result", "step", "text", "step", "end"]);
    assert.deepEqual(lines.at(-1), { jigWorker: 1, exitCode: 2, stats: { stop: "max_steps", steps: 2 } });
    assert.equal(await readFile(join(dir, "work", "src", "app.py"), "utf8"), "print(1)\n");
    assert.equal(JSON.parse(await readFile(join(dir, "work", ".fake-jig.json"), "utf8")).task, "exit 2");
  });

  it("refuses a workspace path that leads out of it, before jig starts", async () => {
    const dir = await tempDir("jig-worker-");
    const { code, stdout, stderr } = await worker({ prompt: "exit 0", workspace: { files: { "../escape": "x" } } }, dir);
    assert.equal(code, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /leads out of the workspace/);
    assert.equal(existsSync(join(dir, "escape")), false);
  });

  /** A warm worker, its claim answered by `answer` (status and body), with the ticket in its environment. */
  async function warmWorker(answer: (req: IncomingMessage) => [number, object]) {
    const claims: { method?: string; url?: string; auth?: string }[] = [];
    const server = createHttpServer((req, res) => {
      claims.push({ method: req.method, url: req.url, auth: req.headers.authorization });
      const [status, body] = answer(req);
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push({ close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))) });
    const child = spawn(process.execPath, [WORKER, "--pool", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`], { env: { PATH: process.env.PATH, JIG_POOL_TICKET: "the ticket" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    return { code, stdout, stderr, claims };
  }

  it("as a warm worker, claims its task with its ticket, and runs jig with the task's token and not the ticket", async () => {
    const dir = await tempDir("jig-worker-");
    const work = join(dir, "work");
    const stats = join(dir, "stats.json");
    const command = [process.execPath, FAKE_JIG, "--events", "-", "--stats", stats, "-C", work, "-"];
    const { code, stdout, claims } = await warmWorker(() => [200, { prompt: "exit 3", workspace: { files: { "app.py": "print(1)\n" } }, gitProtocols: ["https"], work, stats, command, env: { ANTHROPIC_API_KEY: "the task's token" }, report: true }]);
    assert.deepEqual(claims, [{ method: "POST", url: "/internal/pool/claim", auth: "Bearer the ticket" }]);
    assert.equal(code, 3);
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)!), { jigWorker: 1, exitCode: 3, stats: { stop: "max_tokens", steps: 2 } });
    assert.equal(await readFile(join(work, "app.py"), "utf8"), "print(1)\n");
    const jig = JSON.parse(await readFile(join(work, ".fake-jig.json"), "utf8"));
    assert.equal(jig.task, "exit 3");
    assert.equal(jig.env.ANTHROPIC_API_KEY, "the task's token");
    assert.equal(jig.env.JIG_POOL_TICKET, undefined);
  });

  it("as a warm worker, exits with no task when its claim is refused", async () => {
    for (const status of [401, 410]) {
      const { code, stdout, stderr } = await warmWorker(() => [status, { error: "no" }]);
      assert.equal(code, 0);
      assert.equal(stdout, "");
      assert.match(stderr, new RegExp(`its claim was refused \\(${status}\\)`));
    }
  });
});

describe("the warm pool", () => {
  /** A pool whose workers are records the test claims with and ends, its claims served on a listener. */
  async function pool(config: ConstructorParameters<typeof WarmPool>[0]) {
    const workers: { ticket: string; stopped: boolean; exit: () => void }[] = [];
    const warm = new WarmPool<number>(config, async (ticket) => {
      let exit!: () => void;
      const exited = new Promise<void>((done) => (exit = done));
      const worker = { ticket, stopped: false, exit };
      workers.push(worker);
      // Stopped, it exits when the test says: a container takes a moment to go.
      return { slot: workers.length, exited, stop: () => void (worker.stopped = true) };
    });
    const server = createHttpServer((req, res) => void warm.claim(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    servers.push({ close: () => new Promise((done) => (server.closeAllConnections(), server.close(() => done()))) });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/pool/claim`;
    const claim = (ticket?: string, init: RequestInit = {}) => fetch(url, { method: "POST", headers: ticket ? { authorization: `Bearer ${ticket}` } : {}, ...init });
    return { warm, workers, claim };
  }

  it("spends a ticket at its first claim, gives the worker one task, and starts another in its place", async () => {
    const { warm, workers, claim } = await pool({ size: 1 });
    assert.equal(workers.length, 0, "not before it is opened");
    warm.open();
    await until(() => workers.length === 1, "a worker");
    assert.equal((await claim()).status, 401);
    assert.equal((await claim("not a ticket")).status, 401);
    assert.equal((await claim(workers[0].ticket, { method: "GET" })).status, 405);
    const held = claim(workers[0].ticket);
    await until(() => warm.stats().idle === 1, "the claim held");
    assert.equal((await claim(workers[0].ticket)).status, 401, "a second use");
    const taken = warm.take("task_1")!;
    assert.equal(taken.slot, 1);
    assert.equal(workers.length, 2, "another in its place");
    assert.ok(taken.answer({ prompt: "the task" }));
    const answer = await held;
    assert.deepEqual([answer.status, await answer.json()], [200, { prompt: "the task" }]);
    // The next isn't waiting yet: the task starts cold.
    assert.equal(warm.take("task_2"), undefined);
    assert.deepEqual(warm.stats(), { size: 1, idle: 0, starting: 1, hits: 1, misses: 1 });
    // A worker whose claim goes away is stopped, and can't be given a task.
    const gone = new AbortController();
    void claim(workers[1].ticket, { signal: gone.signal }).catch(() => {});
    await until(() => warm.stats().idle === 1, "the second claim held");
    gone.abort();
    await until(() => workers[1].stopped, "the second worker stopped");
    assert.equal(warm.take("task_3"), undefined);
    workers[1].exit();
    await until(() => workers.length === 3, "a third in its place");
    const closing = warm.close();
    assert.ok(workers[2].stopped);
    workers[2].exit();
    await closing;
  });

  it("stops a worker idle past maxIdleSeconds, another in its place, and refuses its ticket as expired", async () => {
    const { warm, workers, claim } = await pool({ size: 1, maxIdleSeconds: 0.3 });
    warm.open();
    const held = claim(workers[0].ticket);
    // Told so in the answer to its claim, stopped, and another started in its place.
    assert.equal((await held).status, 410);
    assert.ok(workers[0].stopped);
    assert.equal(workers.length, 2);
    // One that never claimed is stopped too: its ticket has expired until it is gone, then is as unknown as any.
    await until(() => workers[1].stopped, "the second worker stopped");
    assert.equal(workers.length, 3);
    assert.equal((await claim(workers[1].ticket)).status, 410);
    workers[1].exit();
    await until(async () => (await claim(workers[1].ticket)).status === 401, "the second worker gone");
    const closing = warm.close();
    for (const worker of workers) worker.exit();
    await closing;
  });

  it("starts a worker again only after a pause when one exits before it claims", async () => {
    const { warm, workers } = await pool({ size: 1 });
    warm.open();
    // Its image can't run, say: starting another at once would only loop.
    workers[0].exit();
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(workers.length, 1);
    await until(() => workers.length === 2, "a worker after the pause");
    const closing = warm.close();
    assert.ok(workers[1].stopped);
    workers[1].exit();
    await closing;
  });
});

/**
 * The YAML the deploy files are written in, and no more: block maps and lists, plain, quoted and JSON
 * flow scalars, `|` blocks, whole-line comments, and `---` between documents. Anything else is refused.
 */
function parseYaml(text: string): unknown[] {
  if (/\t/.test(text)) throw new Error("tabs");
  const documents: unknown[] = [];
  for (const part of text.split(/^---$/m)) {
    const lines = part.split("\n");
    let i = 0;
    const indent = (line: string) => line.length - line.trimStart().length;
    const skip = () => {
      while (i < lines.length && /^\s*(#.*)?$/.test(lines[i])) i++;
    };
    const item = (line: string) => /^\s*-( |$)/.test(line);
    const scalar = (value: string): unknown => {
      if (/^["[{]/.test(value)) return JSON.parse(value);
      if (/ #|^[&*!|>'%@`]/.test(value)) throw new Error(`a scalar this reader doesn't take: ${value}`);
      if (value === "true" || value === "false") return value === "true";
      if (value === "null") return null;
      return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    };
    const node = (at: number): unknown => (item(lines[i]) ? list(at) : map(at));
    const list = (at: number): unknown[] => {
      const items: unknown[] = [];
      for (skip(); i < lines.length && indent(lines[i]) === at && item(lines[i]); skip()) {
        const rest = lines[i].trim().slice(1).trim();
        if (/^[\w./-]+:( |$)/.test(rest)) {
          // A map that starts on the dash's line: the same map as if it started on the next.
          lines[i] = `${" ".repeat(at + 2)}${rest}`;
          items.push(map(at + 2));
        } else if (rest) {
          i++;
          items.push(scalar(rest));
        } else {
          i++;
          skip();
          items.push(node(indent(lines[i])));
        }
      }
      return items;
    };
    const map = (at: number): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (skip(); i < lines.length && indent(lines[i]) === at && !item(lines[i]); skip()) {
        const [, key, value = ""] = /^([\w./-]+):(?: (.*))?$/.exec(lines[i].trim()) ?? [];
        if (!key) throw new Error(`line ${i + 1}: ${lines[i]}`);
        if (key in result) throw new Error(`line ${i + 1}: ${key} twice`);
        i++;
        if (value === "|") {
          const block: string[] = [];
          for (; i < lines.length && (!lines[i].trim() || indent(lines[i]) > at); i++) block.push(lines[i]);
          const margin = Math.min(...block.filter((line) => line.trim()).map(indent));
          result[key] = `${block.map((line) => line.slice(margin)).join("\n").trimEnd()}\n`;
        } else if (value) {
          result[key] = scalar(value);
        } else {
          skip();
          const next = lines[i] === undefined ? -1 : indent(lines[i]);
          result[key] = next > at || (next === at && item(lines[i])) ? node(next) : null;
        }
      }
      return result;
    };
    skip();
    if (i === lines.length) continue;
    documents.push(node(indent(lines[i])));
    skip();
    if (i < lines.length) throw new Error(`line ${i + 1} isn't read: ${lines[i]}`);
  }
  return documents;
}

describe("the deploy files", () => {
  async function manifests(): Promise<any[]> {
    const dir = join(DEPLOY, "k8s");
    const all = [];
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".yaml")).sort()) all.push(...parseYaml(await readFile(join(dir, file), "utf8")));
    return all;
  }
  const find = (all: any[], kind: string, name: string) => {
    const found = all.find((doc) => doc.kind === kind && doc.metadata.name === name);
    assert.ok(found, `${kind} ${name}`);
    return found;
  };

  it("parse, with a reader that refuses what it doesn't read", async () => {
    assert.deepEqual(parseYaml('# a comment\na:\n  b: [1]\n  c:\n    - d: x:y\n      e: "no"\n    - 2\n---\nk: |\n  two\n    lines\nl: true\n'), [{ a: { b: [1], c: [{ d: "x:y", e: "no" }, 2] } }, { k: "two\n  lines\n", l: true }]);
    for (const text of ["a: &anchor 1", "a: b # a comment", "a:\n\tb: 1", "a: 1\na: 2", "a: 1\n b: 2", "a: >\n  folded"]) assert.throws(() => parseYaml(text), text);
  });

  it("keep the task pods to the gateway, the internal listener and DNS, and give the service only what the runner needs", async () => {
    const all = await manifests();
    for (const doc of all) assert.ok(doc.apiVersion && doc.kind && doc.metadata.name, JSON.stringify(doc).slice(0, 100));
    for (const doc of all.filter((doc) => !["Namespace", "RuntimeClass"].includes(doc.kind))) assert.equal(doc.metadata.namespace, "jig", `${doc.kind} ${doc.metadata.name}`);

    // The NetworkPolicy selects the pods the runner labels, and lets them reach only the gateway's pods, on
    // its port, the service's pods on the internal listener's port, and DNS.
    const policy = find(all, "NetworkPolicy", "jig-task").spec;
    assert.deepEqual(policy.podSelector.matchLabels, ROLE_LABELS);
    assert.deepEqual(policy.policyTypes, ["Ingress", "Egress"]);
    assert.deepEqual(policy.ingress, []);
    const gateway = find(all, "Deployment", "jig-gateway").spec.template;
    assert.deepEqual(policy.egress[0].to, [{ podSelector: { matchLabels: gateway.metadata.labels } }]);
    assert.deepEqual(policy.egress[0].ports, [{ protocol: "TCP", port: gateway.spec.containers[0].ports[0].containerPort }]);
    const service = find(all, "Deployment", "jig-api").spec.template;
    const { internal, internalBaseUrl } = JSON.parse(find(all, "ConfigMap", "jig-config").data["service.json"]);
    assert.deepEqual(policy.egress[1].to, [{ podSelector: { matchLabels: service.metadata.labels } }]);
    assert.deepEqual(policy.egress[1].ports, [{ protocol: "TCP", port: internal.port }]);
    assert.deepEqual(policy.egress[2].ports.map((port: { port: number }) => port.port), [53, 53]);
    assert.equal(policy.egress.length, 3);
    assert.deepEqual(find(all, "Service", "jig-gateway").spec.selector, gateway.metadata.labels);
    // The internal listener has a Service of its own, which the config tells the tasks; the tenants' has only its port.
    assert.ok(service.spec.containers[0].ports.some((port: { containerPort: number }) => port.containerPort === internal.port));
    assert.deepEqual(find(all, "Service", "jig-api-internal").spec, { selector: service.metadata.labels, ports: [{ port: internal.port, targetPort: internal.port }] });
    assert.equal(internalBaseUrl, `http://jig-api-internal.jig.svc:${internal.port}`);
    assert.deepEqual(find(all, "Service", "jig-api").spec.ports.map((port: { port: number }) => port.port), [8080]);

    // The service's account may run Jobs, follow their pods and make their Secrets, and no more.
    const rules = find(all, "Role", "jig-api").rules.map((rule: any) => [rule.apiGroups, rule.resources, rule.verbs]);
    assert.deepEqual(rules, [[["batch"], ["jobs"], ["create", "get", "patch", "delete"]], [[""], ["pods"], ["get", "list"]], [[""], ["pods/log"], ["get"]], [[""], ["secrets"], ["create"]]]);
    assert.deepEqual(find(all, "RoleBinding", "jig-api").subjects, [{ kind: "ServiceAccount", name: "jig-api", namespace: "jig" }]);
    assert.equal(find(all, "Deployment", "jig-api").spec.template.spec.serviceAccountName, "jig-api");
    assert.equal(find(all, "ServiceAccount", "jig-task").automountServiceAccountToken, false);
    assert.equal(find(all, "RuntimeClass", "gvisor").handler, "runsc");

    // The config: the kubernetes runner, and the gateway's address as its Service has it.
    const config = JSON.parse(find(all, "ConfigMap", "jig-config").data["service.json"]);
    assert.equal(config.runner, "kubernetes");
    assert.ok(config.kubernetes.image);
    assert.equal(config.gatewayBaseUrl, `http://jig-gateway.jig.svc:${find(all, "Service", "jig-gateway").spec.ports[0].port}/anthropic`);
    // Secrets are referenced, never included.
    assert.ok(!all.some((doc) => doc.kind === "Secret"));

    // Two replicas of the service, sharing the database the jig-database Secret names.
    const api = find(all, "Deployment", "jig-api").spec;
    assert.equal(api.replicas, 2);
    assert.equal(config.database, undefined);
    const env = api.template.spec.containers[0].env.find((variable: { name: string }) => variable.name === "JIG_DATABASE_URL");
    assert.deepEqual(env.valueFrom, { secretKeyRef: { name: "jig-database", key: "url" } });
    // Each replica's warm workers claim at its own pod's address, on the internal listener's port.
    const variables = api.template.spec.containers[0].env;
    const own = variables.findIndex((variable: { name: string }) => variable.name === "POD_IP");
    assert.deepEqual(variables[own].valueFrom, { fieldRef: { fieldPath: "status.podIP" } });
    const pool = variables.findIndex((variable: { name: string }) => variable.name === "JIG_POOL_BASE_URL");
    assert.ok(own < pool, "defined before it refers to it");
    assert.equal(variables[pool].value, `http://$(POD_IP):${internal.port}`);
    assert.ok(!all.some((doc) => doc.kind === "PersistentVolumeClaim"), "the replicas share no disk");
  });

  it("put the gateway on the tasks' internal network on one machine, and the worker image runs jig as the runners' user", async () => {
    const [compose] = parseYaml(await readFile(join(DEPLOY, "docker-compose.yml"), "utf8")) as any[];
    assert.deepEqual(compose.networks.tasks, { name: "jig-tasks", internal: true });
    assert.deepEqual(compose.services.gateway.networks, ["default", "tasks"]);
    // The service is on it too, where the tasks reach its internal listener.
    assert.deepEqual(compose.services.api.networks, ["default", "tasks"]);
    assert.ok(compose.services.api.volumes.includes("/var/run/docker.sock:/var/run/docker.sock"));
    const config = JSON.parse(await readFile(join(DEPLOY, "service.docker.json"), "utf8"));
    assert.deepEqual([config.runner, config.docker.network, new URL(config.gatewayBaseUrl).hostname], ["docker", "jig-tasks", "gateway"]);
    assert.equal(config.internalBaseUrl, `http://api:${config.internal.port}`);
    assert.equal(config.internal.host, "0.0.0.0");
    // The data's folder is at the same path for the daemon as for the service.
    assert.ok(compose.services.api.volumes.includes(`${config.dataDir}:${config.dataDir}`));

    const worker = await readFile(join(DEPLOY, "Dockerfile.worker"), "utf8");
    assert.match(worker, /^FROM node:22-slim$/m);
    assert.match(worker, /apt-get install .*\bgit bubblewrap python3\b/);
    assert.match(worker, /^USER 10001:10001$/m);
  });
});
