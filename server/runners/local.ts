import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { type JigEvent, jigArgs, keyVariable, mintToken, type RunExit, type RunHandle, type Runner, workspaceProblem } from "../runner.ts";
import type { Task, Tenant, Workspace } from "../store.ts";

// Runs each task's jig as a process on this machine, in a folder of its own under the data directory:
// work/ is the project jig works in, home/ its HOME and JIG_HOME, and beside them the events and stats files
// jig writes, outside the project, where its sandboxed commands can't write.

export interface LocalRunnerConfig {
  dataDir: string;
  /** How to start jig: a program and its first arguments. */
  jig: string[];
  /** The gateway's Anthropic-compatible base URL, which jig gets as --base-url. */
  gatewayBaseUrl: string;
  /** The secret the gateway checks tokens with (JIG_GATEWAY_SECRET). */
  gatewaySecret: string;
  /** Seconds past the task's time limit before the runner stops a jig that hasn't stopped itself. */
  graceSeconds: number;
  /** The protocols a git workspace may be cloned over (default: https only). */
  gitProtocols?: string[];
  /** How often the events file is read, in milliseconds. */
  pollMs?: number;
}

// The service's environment holds its own secrets (and maybe real provider keys): jig gets only these of it.
const PASSED = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"];
// After SIGTERM, how long jig has to stop its commands before the whole process group is killed.
const TERM_MS = 5_000;

export class LocalRunner implements Runner {
  private config: LocalRunnerConfig;

  constructor(config: LocalRunnerConfig) {
    this.config = config;
  }

  /** The task's folder. */
  dir(id: string): string {
    return join(this.config.dataDir, "tasks", id);
  }

  async start(task: Task, tenant: Tenant): Promise<RunHandle> {
    const { graceSeconds, pollMs = 100 } = this.config;
    const dir = this.dir(task.id);
    const work = join(dir, "work");
    const home = join(dir, "home");
    await rm(dir, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    await mkdir(home);
    await prepareWorkspace(work, task.spec.workspace, this.config.gitProtocols ?? ["https"]);

    const timeLimit = task.spec.timeLimit;
    const exp = Math.floor(Date.now() / 1000) + timeLimit + graceSeconds + 60;
    const token = mintToken(this.config.gatewaySecret, { tenant: tenant.id, task: task.id, exp, budgetUsd: tenant.limits.budgetUsd });
    const env: NodeJS.ProcessEnv = { HOME: home, JIG_HOME: join(home, ".jig"), NO_COLOR: "1", [keyVariable(task.spec.model)]: token };
    for (const name of PASSED) if (process.env[name] !== undefined) env[name] = process.env[name];

    const events = join(dir, "events.jsonl");
    const stats = join(dir, "stats.json");
    const log = join(dir, "output.log");
    const out = openSync(log, "w");
    const [program, ...first] = this.config.jig;
    // A process group of its own, so a cancel or the time limit reaches what jig started too.
    const child = spawn(program, [...first, ...jigArgs(task, { cwd: work, events, stats, baseUrl: this.config.gatewayBaseUrl })], { cwd: work, env, detached: true, stdio: ["pipe", out, out] });
    closeSync(out);
    child.stdin!.on("error", () => {}); // a jig that exits before reading its task
    child.stdin!.end(task.spec.prompt);

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {} // the group is gone
    };
    let exited = false;
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (exited) return;
      killGroup("SIGTERM");
      killer ??= setTimeout(() => killGroup("SIGKILL"), TERM_MS);
    };
    const deadline = setTimeout(() => ((timedOut = true), stop()), (timeLimit + graceSeconds) * 1000);
    const exit = new Promise<RunExit>((done) => {
      child.on("error", (err) => {
        exited = true;
        clearTimeout(deadline);
        done({ exitCode: null, timedOut, message: `jig didn't start: ${err.message}` });
      });
      child.on("exit", (code) => {
        exited = true;
        clearTimeout(deadline);
        clearTimeout(killer);
        // Whatever jig left in its group (a job in the background, say) ends with it.
        killGroup("SIGKILL");
        done({ exitCode: code, timedOut });
      });
    }).then(async (result) => ({
      ...result,
      stats: await readFile(stats, "utf8").then(JSON.parse, () => undefined),
      message: result.message ?? (result.exitCode === 0 ? undefined : await lastLine(log)),
    }));
    return { events: tail(events, () => exited, pollMs), wait: () => exit, cancel: stop };
  }
}

/** Writes a task's files into its (empty) workspace, or clones its repository there. */
async function prepareWorkspace(work: string, workspace: Workspace | undefined, protocols: string[]): Promise<void> {
  for (const [path, contents] of Object.entries(workspace?.files ?? {})) {
    const problem = workspaceProblem(path);
    if (problem) throw new Error(`The workspace file ${JSON.stringify(path)} ${problem}.`);
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), contents, { flag: "wx" });
  }
  if (!workspace?.git) return;
  // Shallow, with no hooks or templates (whose hooks a clone would run) and only the protocols allowed: git
  // runs a program for some others (ext::).
  const args = ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "clone", "--quiet", "--depth", "1", "--no-tags", ...(workspace.ref ? ["--branch", workspace.ref] : []), "--", workspace.git, work];
  const env = { PATH: process.env.PATH, HOME: dirname(work), GIT_ALLOW_PROTOCOL: protocols.join(":"), GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  await promisify(execFile)("git", args, { env, timeout: 120_000 }).catch((err: { stderr?: string; message: string }) => {
    throw new Error(`git clone failed: ${(err.stderr || err.message).trim()}`);
  });
}

/**
 * The events jig appends to `file`, as it writes them, until `finished()` and the last of them is read. A
 * line that isn't an event (or a last one cut short by a crash) is left out.
 */
async function* tail(file: string, finished: () => boolean, pollMs: number): AsyncGenerator<JigEvent> {
  const decoder = new StringDecoder("utf8");
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  let partial = "";
  for (;;) {
    // Looked at before the read, so the read after jig's exit gets all it wrote.
    const last = finished();
    const handle = await open(file, "r").catch(() => undefined);
    if (handle) {
      try {
        for (let read; (read = (await handle.read(chunk, 0, chunk.length, offset)).bytesRead) > 0; offset += read) partial += decoder.write(chunk.subarray(0, read));
      } finally {
        await handle.close();
      }
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        const event = parseEvent(line);
        if (event) yield event;
      }
    }
    if (last) return;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

function parseEvent(line: string): JigEvent | undefined {
  try {
    const event = JSON.parse(line);
    return event && Number.isInteger(event.seq) && event.seq > 0 && typeof event.type === "string" ? event : undefined;
  } catch {
    return undefined;
  }
}

/** The last line of what jig printed (of its last 4 KB), cut to 500 characters. */
async function lastLine(log: string): Promise<string | undefined> {
  const handle = await open(log, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const { size } = await handle.stat();
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, Math.max(0, size - 4096));
    return buffer.subarray(0, bytesRead).toString("utf8").trim().split("\n").at(-1)?.slice(-500) || undefined;
  } finally {
    await handle.close();
  }
}
