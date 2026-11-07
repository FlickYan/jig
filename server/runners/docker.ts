import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { lchown, mkdir, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createLog, type Log } from "../log.ts";
import { type Exited, type PoolConfig, type Started, type Warm, WarmPool } from "../pool.ts";
import { jigArgs, keyVariable, type RunExit, type RunHandle, type Runner, taskFolders, taskToken } from "../runner.ts";
import type { Task, Tenant } from "../store.ts";
import type { PoolAnswer } from "../worker.ts";
import { lastLine, prepareWorkspace, readStats, TERM_MS, tail } from "./local.ts";

// Runs each task's jig in a container of its own, through the docker CLI: `docker run --rm` with limits on
// CPU, memory and processes, a read-only root, no capabilities, and a network that reaches only the
// gateway. The task's folder is made here as the local runner makes it and bound into the container at
// /task; the events file jig writes there is read from this side. With a pool, containers are started
// ahead of tasks, each with a folder of its own, and a task is given to one that waits (pool.ts).

export interface DockerRunnerConfig {
  /** Where the task folders go. The daemon binds them by this path, so it must be the same on its machine. */
  dataDir: string;
  /** How to run the docker CLI: a program and its first arguments (default: docker). */
  docker?: string[];
  /** The worker image (deploy/Dockerfile.worker). */
  image: string;
  /** How to start jig in the image (default: jig). */
  jig?: string[];
  /** The network the containers join: an internal one, with the gateway on it too. */
  network: string;
  /** --runtime: runsc for gVisor, kata for Kata Containers; the daemon's default (runc) without one. */
  runtime?: string;
  /** CPUs (1), memory, with no swap beyond it ("2g"), processes (512) and the size of /tmp ("512m"). */
  cpus?: number;
  memory?: string;
  pidsLimit?: number;
  tmpSize?: string;
  /** The uid:gid jig runs as (10001:10001, the image's jig user). */
  user?: string;
  gatewayBaseUrl: string;
  gatewaySecret: string;
  graceSeconds: number;
  gitProtocols?: string[];
  /** Whether a clone follows a redirect on its first request (default: no, as with gitHosts). */
  gitRedirects?: boolean;
  /** The service's internal listener as the containers reach it, on the network: where tasks ask for approvals. */
  internalBaseUrl?: string;
  /** Workers started ahead of tasks (pool.ts): none unless `size` is set. */
  pool?: PoolConfig;
  /** How a warm worker starts in the image (default: node /opt/jig/server/worker.ts). */
  worker?: string[];
  pollMs?: number;
  /** Where the runner's and its pool's lines go (default: the service's log). */
  log?: Log;
}

// The docker CLI needs these of the service's environment to reach its daemon; it gets nothing else of it.
const PASSED = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];
// How often a kill that missed, or a KILL the run outlived, is sent again.
const RETRY_MS = 1_000;

export class DockerRunner implements Runner {
  /** The workers started ahead of tasks, if the config asks for any. */
  readonly pool?: WarmPool<Slot>;
  private config: DockerRunnerConfig;
  /** The folders of tasks run on a warm worker: its slot's, not one named for the task. */
  private folders = new Map<string, string>();
  /** Where the warm workers claim their tasks. */
  private poolUrl = "";
  private log: Log;

  constructor(config: DockerRunnerConfig) {
    this.config = config;
    this.log = config.log ?? createLog("service");
    if (config.pool?.size) this.pool = new WarmPool(config.pool, (ticket) => this.launchWarm(ticket), this.log);
  }

  /** The task's folder. */
  dir(id: string): string {
    return this.folders.get(id) ?? join(this.config.dataDir, "tasks", id);
  }

  async removeFiles(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
    this.folders.delete(id);
  }

  /** The cold tasks' folders: a warm worker's (pool_<hex>) is its slot's, and stays (docs/server.md). */
  leftovers(): Promise<string[]> {
    return taskFolders(this.config.dataDir);
  }

  warm(internalBaseUrl: string): void {
    this.poolUrl = this.config.pool?.baseUrl ?? internalBaseUrl;
    this.pool?.open();
  }

  async claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.pool) return void res.writeHead(404, { "content-type": "application/json" }).end(`${JSON.stringify({ error: "This service keeps no warm workers" })}\n`);
    return this.pool.claim(req, res);
  }

  async close(): Promise<void> {
    await this.pool?.close();
  }

  /**
   * Kills the container a gone replica left running for the task, if it is on this replica's daemon: a cold
   * one is named for its task, and a warm worker's is renamed for its task when given it (startWarm).
   */
  async abandon(id: string): Promise<void> {
    const { docker = ["docker"] } = this.config;
    const [program, ...first] = docker;
    const name = `jig-${id}`;
    const killer = spawn(program, [...first, "kill", "--signal", "KILL", name], { env: cliEnv(), stdio: ["ignore", "ignore", "pipe"], timeout: TERM_MS });
    let said = "";
    killer.stderr!.on("data", (chunk) => (said += chunk));
    const code = await new Promise<number | null>((done, fail) => killer.on("error", fail).on("close", done));
    // No such container: it has ended, or runs on another daemon.
    if (code !== 0 && !/no such container/i.test(said)) throw new Error(`docker kill ${name} exited with ${code}: ${said.trim().slice(-500)}`);
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const warm = this.pool?.take(task.id);
    const handle = warm && (await this.startWarm(warm, task, tenant));
    if (handle) return handle;
    const { jig = ["jig"], graceSeconds } = this.config;
    const dir = this.dir(task.id);
    await this.makeFolder(dir);
    await prepareWorkspace(join(dir, "work"), task.spec.workspace, this.config.gitProtocols ?? ["https"], this.log.with({ tenant: tenant.id, task: task.id }), this.config.gitRedirects);
    await this.chown(dir);

    // The token goes by name only (-e NAME), its value in the CLI's environment, out of the process list.
    const key = keyVariable(task.spec.model);
    const name = `jig-${task.id}`;
    const args = [
      ...this.runArgs(name, dir, ["--interactive", "--label", `jig.task=${task.id}`, "--label", `jig.tenant=${tenant.id}`], key),
      // The container is the boundary: bubblewrap would need Docker's seccomp filter and /proc masks loosened.
      ...jig, "--no-sandbox", ...this.jigArgs(task, tenant),
    ];
    const container = this.launch(name, args, { [key]: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds) }, join(dir, "output.log"), task.spec.prompt);
    return this.handle(container, dir, task);
  }

  /**
   * Runs the task on a warm worker: its workspace made in the slot's folder, which the container has bound
   * since it started, and the rest, what a cold start passes to docker run, in the answer to its claim.
   * Undefined if the worker went away meanwhile, and the task starts cold.
   */
  private async startWarm(warm: Warm<Slot>, task: Task, tenant: Tenant): Promise<RunHandle | undefined> {
    const { jig = ["jig"], graceSeconds } = this.config;
    const { name, dir, container } = warm.slot;
    try {
      await prepareWorkspace(join(dir, "work"), task.spec.workspace, this.config.gitProtocols ?? ["https"], this.log.with({ tenant: tenant.id, task: task.id }), this.config.gitRedirects);
      await this.chown(dir);
    } catch (err) {
      warm.stop();
      throw err;
    }
    const answer: PoolAnswer = {
      prompt: task.spec.prompt,
      gitProtocols: this.config.gitProtocols ?? ["https"],
      work: "/task/work",
      stats: "/task/stats.json",
      command: [...jig, "--no-sandbox", ...this.jigArgs(task, tenant)],
      env: { [keyVariable(task.spec.model)]: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds) },
    };
    if (!warm.answer(answer)) return undefined;
    warm.slot.assigned = true;
    this.folders.set(task.id, dir);
    // Named as a cold one would be, so a replica that ends the task after this one crashed finds it (abandon).
    // Only once it has the task: a cold start of it would want the name. One not renamed runs all the same.
    const renamed = `jig-${task.id}`;
    await container.rename(renamed).then(
      () => (warm.slot.name = renamed),
      // A run that has already ended is gone, and needs no name.
      (err: unknown) => container.exited() || this.log.warn("couldn't rename a warm worker's container for its task; if this replica crashes, the replica that ends the task may not find it, and the run goes on until its time limit", { task: task.id, container: name, err }),
    );
    // The folder keeps the worker's name, not the task's: this says which it is.
    this.log.info("the task runs on a warm worker", { task: task.id, tenant: tenant.id, container: warm.slot.name, folder: dir });
    return { ...this.handle(container, dir, task), warm: true };
  }

  /** A warm worker: a container with its own slot's folder at /task, as a task's, that claims a task with its ticket. */
  private async launchWarm(ticket: string): Promise<Started<Slot>> {
    const { worker = ["node", "/opt/jig/server/worker.ts"] } = this.config;
    const id = `pool_${randomBytes(12).toString("hex")}`;
    const dir = join(this.config.dataDir, "tasks", id);
    await this.makeFolder(dir);
    await this.chown(dir);
    const name = `jig-${id}`;
    const args = [...this.runArgs(name, dir, ["--label", `jig.pool=${id}`], "JIG_POOL_TICKET"), ...worker, "--pool", this.poolUrl];
    const container = this.launch(name, args, { JIG_POOL_TICKET: ticket }, join(dir, "output.log"));
    const slot: Slot = { name, dir, container, assigned: false };
    // A worker that never got a task leaves its folder; one that did, the task's. The pool waits on this,
    // not on the exit alone, so a service that closes has removed the folders of its idle workers. What
    // one that never got a task said last is read first, for the pool to log.
    const exited = container.exit.then(async ({ code, message }): Promise<Exited> => {
      if (slot.assigned) return { code };
      const said = message ?? (await lastLine(join(dir, "output.log")).catch(() => undefined));
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return { code, said };
    });
    return { slot, exited, stop: container.stop };
  }

  private async makeFolder(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "work"), { recursive: true });
    await mkdir(join(dir, "home"));
  }

  /** A service running as root (as one holding the docker socket may) makes the folder root's, which jig, not root in the container, couldn't write. */
  private async chown(dir: string): Promise<void> {
    const [uid, gid] = (this.config.user ?? "10001:10001").split(":").map(Number);
    if (process.getuid?.() === 0 && Number.isInteger(uid) && Number.isInteger(gid)) await chownTree(dir, uid, gid);
  }

  /** docker run's arguments up to the image: the limits and isolation every container gets, cold or warm. */
  private runArgs(name: string, dir: string, extra: string[], key: string): string[] {
    return [
      "run", "--rm", "--init", "--name", name, ...extra,
      "--user", this.config.user ?? "10001:10001",
      "--cpus", String(this.config.cpus ?? 1), "--memory", this.config.memory ?? "2g", "--memory-swap", this.config.memory ?? "2g", "--pids-limit", String(this.config.pidsLimit ?? 512),
      "--read-only", "--tmpfs", `/tmp:rw,nosuid,nodev,size=${this.config.tmpSize ?? "512m"}`, "--mount", `type=bind,source=${dir},target=/task`, "--workdir", "/task/work",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      ...(this.config.runtime ? ["--runtime", this.config.runtime] : []),
      "--network", this.config.network,
      "--env", "HOME=/task/home", "--env", "JIG_HOME=/task/home/.jig", "--env", "NO_COLOR=1", "--env", key,
      this.config.image,
    ];
  }

  private jigArgs(task: Task, tenant: Tenant): string[] {
    return jigArgs(task, tenant, { cwd: "/task/work", events: "/task/events.jsonl", stats: "/task/stats.json", baseUrl: this.config.gatewayBaseUrl, internalBaseUrl: this.config.internalBaseUrl });
  }

  /** Starts docker run, `secrets` in the CLI's environment only, its output to `log`, and `stdin` to the container. */
  private launch(name: string, args: string[], secrets: Record<string, string>, log: string, stdin?: string): Container {
    const { docker = ["docker"] } = this.config;
    const env = cliEnv(secrets);
    const out = openSync(log, "w");
    const [program, ...first] = docker;
    const child = spawn(program, [...first, ...args], { env, stdio: [stdin === undefined ? "ignore" : "pipe", out, out] });
    closeSync(out);
    if (stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(stdin);
    }

    // The names it may have now, tried in turn: a warm worker's is changed to its task's.
    let names = [name];
    /** Whether the signal reached the container by `target`. */
    const killAs = (signal: string, target: string) =>
      new Promise<boolean>((done) => {
        const killer = spawn(program, [...first, "kill", "--signal", signal, target], { env, stdio: "ignore", timeout: TERM_MS });
        killer.on("error", () => done(false));
        killer.on("exit", (code) => done(code === 0));
      });
    /** Whether the signal reached the container. */
    const kill = async (signal: string) => {
      for (const target of names) if (await killAs(signal, target)) return true;
      return false;
    };
    // A kill sent by the old name as the rename lands misses, and is sent again, as one sent too soon is.
    const rename = (to: string) =>
      new Promise<void>((done, fail) => {
        const from = names[0];
        const renamer = spawn(program, [...first, "rename", from, to], { env: cliEnv(), stdio: ["ignore", "ignore", "pipe"], timeout: TERM_MS });
        let started = false;
        let said = "";
        renamer.on("spawn", () => (started = true));
        renamer.stderr!.on("data", (chunk) => (said += chunk));
        renamer.on("error", fail);
        renamer.on("close", (code, signal) => {
          if (code === 0) return (names = [to]), done();
          const why = code === null ? `docker rename was stopped (${signal})` : `docker rename exited with ${code}: ${said.trim().slice(-500)}`;
          // The daemon said no, or the CLI didn't start: it keeps its name. Otherwise (the CLI cut off at its
          // time limit, a slow daemon) the rename may have landed, or land later, so kills try both names.
          if (!started || /error response from daemon/i.test(said)) return fail(new Error(why));
          names = [from, to];
          fail(new Error(`${why}; it may have been renamed all the same, so it is sent its signals by either name`));
        });
      });
    let exited = false;
    let stopping = false;
    let timer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    // A pause the run's exit cuts short.
    const pause = (ms: number) => new Promise<void>((done) => (exited ? done() : ((wake = done), (timer = setTimeout(done, ms)))));
    // The container may not exist yet (its image still being pulled, or a busy daemon), and a kill then
    // misses: TERM is sent again until one reaches it, and KILL from 5 seconds later until the run ends.
    const stop = () => {
      if (exited || stopping) return;
      stopping = true;
      void (async () => {
        while (!exited && !(await kill("TERM"))) await pause(RETRY_MS);
        await pause(TERM_MS);
        while (!exited) {
          await kill("KILL");
          await pause(RETRY_MS);
        }
      })();
    };
    const exit = new Promise<{ code: number | null; message?: string }>((done) => {
      const end = (result: { code: number | null; message?: string }) => {
        exited = true;
        clearTimeout(timer);
        wake?.();
        done(result);
      };
      child.on("error", (err) => end({ code: null, message: `docker didn't start: ${err.message}` }));
      // docker run exits with the container's code, or 125 to 127 when it couldn't run it.
      child.on("exit", (code) => end({ code }));
    });
    return { exit, exited: () => exited, stop, rename };
  }

  /** A task's run in the container, from now: its events read from the folder, and stopped at its time limit and the grace. */
  private handle(container: Container, dir: string, task: Task): RunHandle {
    const { graceSeconds, pollMs = 100 } = this.config;
    let timedOut = false;
    const deadline = setTimeout(() => ((timedOut = true), container.stop()), (task.spec.timeLimit + graceSeconds) * 1000);
    const exit = container.exit.then(async ({ code, message }): Promise<RunExit> => {
      clearTimeout(deadline);
      return { exitCode: code, timedOut, stats: await readStats(join(dir, "stats.json")), message: message ?? (code === 0 ? undefined : await lastLine(join(dir, "output.log"))) };
    });
    return { events: tail(join(dir, "events.jsonl"), container.exited, pollMs), wait: () => exit, cancel: container.stop };
  }
}

/** A docker run of the runner's. */
interface Container {
  /** docker run's exit code (null if it didn't start, with why). */
  exit: Promise<{ code: number | null; message?: string }>;
  exited(): boolean;
  /** TERM, sent until it reaches the container, then KILL 5 seconds later until it has exited. */
  stop(): void;
  /**
   * Renames the container, which is sent its signals by the new name from then on; fails as docker rename
   * does, and when that leaves it unknown whether the rename landed, by the old name and then the new.
   */
  rename(to: string): Promise<void>;
}

/** A warm worker's container, by its name (its task's once given one), and folder; `assigned` once a task is given to it. */
interface Slot {
  name: string;
  dir: string;
  container: Container;
  assigned: boolean;
}

/** The docker CLI's environment: what it needs of the service's to reach its daemon, and `secrets`. */
function cliEnv(secrets: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...secrets };
  for (const variable of PASSED) if (process.env[variable] !== undefined) env[variable] = process.env[variable];
  return env;
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await lchown(path, uid, gid);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await chownTree(join(path, entry.name), uid, gid);
    else await lchown(join(path, entry.name), uid, gid);
  }
}
