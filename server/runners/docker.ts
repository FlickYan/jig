import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { lchown, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { jigArgs, keyVariable, type RunExit, type RunHandle, type Runner, taskToken } from "../runner.ts";
import type { Task, Tenant } from "../store.ts";
import { lastLine, prepareWorkspace, readStats, TERM_MS, tail } from "./local.ts";

// Runs each task's jig in a container of its own, through the docker CLI: `docker run --rm` with limits on
// CPU, memory and processes, a read-only root, no capabilities, and a network that reaches only the
// gateway. The task's folder is made here as the local runner makes it and bound into the container at
// /task; the events file jig writes there is read from this side.

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
  /** The service's internal listener as the containers reach it, on the network: where tasks ask for approvals. */
  internalBaseUrl?: string;
  pollMs?: number;
}

// The docker CLI needs these of the service's environment to reach its daemon; it gets nothing else of it.
const PASSED = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];
// How often a kill that missed, or a KILL the run outlived, is sent again.
const RETRY_MS = 1_000;

export class DockerRunner implements Runner {
  private config: DockerRunnerConfig;

  constructor(config: DockerRunnerConfig) {
    this.config = config;
  }

  /** The task's folder. */
  dir(id: string): string {
    return join(this.config.dataDir, "tasks", id);
  }

  async removeFiles(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const { docker = ["docker"], jig = ["jig"], user = "10001:10001", graceSeconds, pollMs = 100 } = this.config;
    const dir = this.dir(task.id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, "work"), { recursive: true });
    await mkdir(join(dir, "home"));
    await prepareWorkspace(join(dir, "work"), task.spec.workspace, this.config.gitProtocols ?? ["https"]);
    // A service running as root (as one holding the docker socket may) makes the folder root's, which jig,
    // not root in the container, couldn't write.
    const [uid, gid] = user.split(":").map(Number);
    if (process.getuid?.() === 0 && Number.isInteger(uid) && Number.isInteger(gid)) await chownTree(dir, uid, gid);

    // The token goes by name only (-e NAME), its value in the CLI's environment, out of the process list.
    const key = keyVariable(task.spec.model);
    const env: NodeJS.ProcessEnv = { [key]: taskToken(this.config.gatewaySecret, task, tenant, graceSeconds) };
    for (const name of PASSED) if (process.env[name] !== undefined) env[name] = process.env[name];
    const name = `jig-${task.id}`;
    const args = [
      "run", "--rm", "--interactive", "--init", "--name", name, "--label", `jig.task=${task.id}`, "--label", `jig.tenant=${tenant.id}`,
      "--user", user,
      "--cpus", String(this.config.cpus ?? 1), "--memory", this.config.memory ?? "2g", "--memory-swap", this.config.memory ?? "2g", "--pids-limit", String(this.config.pidsLimit ?? 512),
      "--read-only", "--tmpfs", `/tmp:rw,nosuid,nodev,size=${this.config.tmpSize ?? "512m"}`, "--mount", `type=bind,source=${dir},target=/task`, "--workdir", "/task/work",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      ...(this.config.runtime ? ["--runtime", this.config.runtime] : []),
      "--network", this.config.network,
      "--env", "HOME=/task/home", "--env", "JIG_HOME=/task/home/.jig", "--env", "NO_COLOR=1", "--env", key,
      this.config.image,
      // The container is the boundary: bubblewrap would need Docker's seccomp filter and /proc masks loosened.
      ...jig, "--no-sandbox", ...jigArgs(task, tenant, { cwd: "/task/work", events: "/task/events.jsonl", stats: "/task/stats.json", baseUrl: this.config.gatewayBaseUrl, internalBaseUrl: this.config.internalBaseUrl }),
    ];
    const log = join(dir, "output.log");
    const out = openSync(log, "w");
    const [program, ...first] = docker;
    const child = spawn(program, [...first, ...args], { env, stdio: ["pipe", out, out] });
    closeSync(out);
    child.stdin!.on("error", () => {});
    child.stdin!.end(task.spec.prompt);

    /** Whether the signal reached the container. */
    const kill = (signal: string) =>
      new Promise<boolean>((done) => {
        const killer = spawn(program, [...first, "kill", "--signal", signal, name], { env, stdio: "ignore", timeout: TERM_MS });
        killer.on("error", () => done(false));
        killer.on("exit", (code) => done(code === 0));
      });
    let exited = false;
    let timedOut = false;
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
    const deadline = setTimeout(() => ((timedOut = true), stop()), (task.spec.timeLimit + graceSeconds) * 1000);
    const stats = join(dir, "stats.json");
    const exit = new Promise<RunExit>((done) => {
      child.on("error", (err) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(timer);
        wake?.();
        done({ exitCode: null, timedOut, message: `docker didn't start: ${err.message}` });
      });
      // docker run exits with the container's code, or 125 to 127 when it couldn't run it.
      child.on("exit", (code) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(timer);
        wake?.();
        done({ exitCode: code, timedOut });
      });
    }).then(async (result) => ({
      ...result,
      stats: await readStats(stats),
      message: result.message ?? (result.exitCode === 0 ? undefined : await lastLine(log)),
    }));
    return { events: tail(join(dir, "events.jsonl"), () => exited, pollMs), wait: () => exit, cancel: stop };
  }
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await lchown(path, uid, gid);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await chownTree(join(path, entry.name), uid, gid);
    else await lchown(join(path, entry.name), uid, gid);
  }
}
