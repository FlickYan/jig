import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "./store.ts";
import { prepareWorkspace, readStats } from "./runners/local.ts";

// The entry point of a task's pod (runners/k8s.ts): `node server/worker.ts <task.json> <jig and its
// arguments>`. A pod has no stdin to give jig its task on, and nothing on the service's side to make its
// workspace in, so this does both: it makes the workspace as the local runner does, starts jig with the
// prompt on stdin, and once jig has exited prints one line of its own after jig's events, {"jigWorker": 1,
// "exitCode", "stats"}, and exits as jig did.

/** What the runner puts in the task's Secret as task.json. */
export interface WorkerInput {
  prompt: string;
  workspace?: Workspace;
  gitProtocols: string[];
  /** The folder jig works in, and its --stats file. */
  work: string;
  stats: string;
}

async function main(): Promise<void> {
  const [input, program, ...args] = process.argv.slice(2);
  if (!program) throw new Error("Usage: node server/worker.ts <task.json> <jig> [arguments]");
  const task: WorkerInput = JSON.parse(await readFile(input, "utf8"));
  await mkdir(task.work, { recursive: true });
  await prepareWorkspace(task.work, task.workspace, task.gitProtocols);

  const child = spawn(program, args, { cwd: task.work, stdio: ["pipe", "inherit", "inherit"] });
  child.stdin!.on("error", () => {});
  child.stdin!.end(task.prompt);
  // As the pod's first process this one ignores signals it has no handler for: the kubelet's SIGTERM is
  // passed on to jig, which stops its commands and ends the run.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  const exitCode = await new Promise<number>((done, fail) => {
    child.on("error", (err) => fail(new Error(`jig didn't start: ${err.message}`)));
    child.on("exit", (code, signal) => done(code ?? 128 + (signal ? constants.signals[signal] : 0)));
  });
  const line = `${JSON.stringify({ jigWorker: 1, exitCode, stats: await readStats(task.stats) })}\n`;
  process.stdout.write(line, () => process.exit(exitCode));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
