import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "./store.ts";
import { createLog } from "./log.ts";
import { prepareWorkspace, readStats } from "./runners/local.ts";

// The entry point of a task's pod (runners/k8s.ts): `node server/worker.ts <task.json> <jig and its
// arguments>`. A pod has no stdin to give jig its task on, and nothing on the service's side to make its
// workspace in, so this does both: it makes the workspace as the local runner does, starts jig with the
// prompt on stdin, and once jig has exited prints one line of its own after jig's events, {"jigWorker": 1,
// "exitCode", "stats"}, and exits as jig did.
//
// A warm worker (pool.ts), started ahead of its task, is `node server/worker.ts --pool <internal listener>`
// with its ticket in JIG_POOL_TICKET: it claims a task there, and the answer holds the task, jig's
// arguments and the task's token, which it runs the same way. It exits after that one task, or with none
// if its claim is refused (401 or 410: its ticket was spent, or has expired).

/** What the runner puts in the task's Secret as task.json. */
export interface WorkerInput {
  prompt: string;
  workspace?: Workspace;
  gitProtocols: string[];
  /** Whether the clone follows a redirect on its first request: not unless the runner says so. */
  gitRedirects?: boolean;
  /** The folder jig works in, and its --stats file. */
  work: string;
  stats: string;
}

/** The answer to a warm worker's claim: the task, and how its jig starts. */
export interface PoolAnswer extends WorkerInput {
  /** jig and its arguments. */
  command: string[];
  /** What jig's environment has beyond the worker's: the task's token, as its API key. */
  env: Record<string, string>;
  /** Print the worker's line after jig's events, as the Kubernetes runner reads it from the pod's log. */
  report?: boolean;
}

let child: ChildProcess | undefined;

async function main(): Promise<void> {
  // As the pod's first process this one ignores signals it has no handler for: the kubelet's SIGTERM is
  // passed on to jig, which stops its commands and ends the run; before jig starts, it ends the worker.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => (child ? child.kill(signal) : process.exit(128 + constants.signals[signal])));
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--pool") {
    const answer = await claim(rest[0]);
    if (!answer) return;
    const [program, ...args] = answer.command;
    return run(answer, program, args, answer.env, answer.report ?? false);
  }
  const [program, ...args] = rest;
  if (!first || !program) throw new Error("Usage: node server/worker.ts <task.json> <jig> [arguments], or --pool <internal listener>");
  return run(JSON.parse(await readFile(first, "utf8")), program, args, {}, true);
}

/** The task a warm worker is given, waited for as long as it takes; undefined if its claim is refused. */
async function claim(baseUrl: string | undefined): Promise<PoolAnswer | undefined> {
  const ticket = process.env.JIG_POOL_TICKET;
  // Spent once it is used, but jig and its commands get an environment without it all the same.
  delete process.env.JIG_POOL_TICKET;
  if (!baseUrl || !ticket) throw new Error("A warm worker needs --pool <the internal listener>, and its ticket in JIG_POOL_TICKET");
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/internal/pool/claim`);
  // node:http, which has no timeout of its own: the answer comes when a task does.
  const res = await new Promise<IncomingMessage>((done, fail) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "POST", headers: { authorization: `Bearer ${ticket}`, "content-length": 0 } }, done);
    // The claim may wait many minutes: keepalive breaks it if the replica's node dies, and the worker exits
    // rather than wait out its Job's deadline.
    req.on("socket", (socket) => socket.setKeepAlive(true, 15_000));
    req.on("error", fail);
    req.end();
  });
  let text = "";
  for await (const chunk of res) text += chunk;
  if (res.statusCode === 401 || res.statusCode === 410) {
    console.error(`jig worker: no task for it: its claim was refused (${res.statusCode})`);
    return undefined;
  }
  if (res.statusCode !== 200) throw new Error(`The claim failed: ${res.statusCode} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Makes the workspace and runs jig in it, the prompt on stdin, then exits as jig did. */
async function run(task: WorkerInput, program: string, args: string[], env: Record<string, string>, report: boolean): Promise<void> {
  // The pod's HOME is in /task, which starts empty: git config --global or pip install --user need it there.
  if (process.env.HOME) await mkdir(process.env.HOME, { recursive: true });
  await mkdir(task.work, { recursive: true });
  // What git says of a failed clone is in the pod's log; the task's error says only that it failed.
  await prepareWorkspace(task.work, task.workspace, task.gitProtocols, createLog("worker"), task.gitRedirects ?? false);
  child = spawn(program, args, { cwd: task.work, env: { ...process.env, ...env }, stdio: ["pipe", "inherit", "inherit"] });
  child.stdin!.on("error", () => {});
  child.stdin!.end(task.prompt);
  const exitCode = await new Promise<number>((done, fail) => {
    child!.on("error", (err) => fail(new Error(`jig didn't start: ${err.message}`)));
    child!.on("exit", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  if (!report) process.exit(exitCode);
  const line = `${JSON.stringify({ jigWorker: 1, exitCode, stats: await readStats(task.stats) })}\n`;
  process.stdout.write(line, () => process.exit(exitCode));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
