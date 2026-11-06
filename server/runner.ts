import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { Task, TaskStatus, Tenant } from "./store.ts";

// What runs a task: the interface every runner keeps (runners/local.ts, docker.ts and k8s.ts),
// and what they share: jig's command line, the task's gateway token, and how jig's exit becomes a status.

/** One line of jig's --events file (the event contract, v1). Readers ignore types they don't know. */
export interface JigEvent {
  v: number;
  seq: number;
  ts: string;
  type: string;
  [field: string]: unknown;
}

export interface RunExit {
  /** jig's exit code, or null if a signal ended it. */
  exitCode: number | null;
  /** The runner stopped it at the task's time limit and grace, as jig didn't stop itself. */
  timedOut: boolean;
  /** jig's --stats file, if it left one. */
  stats?: unknown;
  /** Why it failed, where jig said so (the last line it printed). */
  message?: string;
}

export interface RunHandle {
  /** The run's events as jig writes them; ends after the run does, with the last of them. */
  events: AsyncIterable<JigEvent>;
  wait(): Promise<RunExit>;
  /** Stops the run and everything it started. */
  cancel(): void;
  /** It runs on a worker started ahead of it (pool.ts), rather than one started for it. */
  warm?: boolean;
}

export interface Runner {
  start(task: Task, tenant: Tenant): Promise<RunHandle>;
  /** The workers it keeps warm, if it keeps any: how many wait for a task. */
  readonly pool?: { stats(): { idle: number } };
  /** Removes what a task's run left on this machine (its folder), once the run has ended. */
  removeFiles?(id: string): Promise<void>;
  /**
   * Stops what may still run of a task whose replica is gone (its container or Job), as far as this
   * replica can reach it: the task has ended as an error, and the run would spend until its deadline.
   */
  abandon?(id: string): Promise<void>;
  /** Starts the workers it keeps warm (pool.ts), which claim their tasks at the internal listener, as they reach it. */
  warm?(internalBaseUrl: string): void;
  /** Answers a warm worker's claim, POST /internal/pool/claim on the internal listener. */
  claim?(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Stops the workers it keeps warm, and settles once they are gone: the service is shutting down. */
  close?(): Promise<void>;
}

/** A gateway token's payload (the token contract). */
export interface TokenPayload {
  tenant: string;
  task: string;
  /** Unix seconds. */
  exp: number;
  budgetUsd: number | null;
}

/**
 * The credential a task's jig uses as its API key: "jgt1." + base64url(payload) + "." + base64url of the
 * HMAC-SHA256 of what comes before the dot, keyed by the secret the service shares with the gateway.
 */
export function mintToken(secret: string, payload: TokenPayload): string {
  const body = `jgt1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** The token a task's run gets as its key: good until its time limit, the grace and a minute more. */
export function taskToken(secret: string, task: Task, tenant: Tenant, graceSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + task.spec.timeLimit + graceSeconds + 60;
  return mintToken(secret, { tenant: tenant.id, task: task.id, exp, budgetUsd: tenant.limits.budgetUsd });
}

/** The variable jig reads its key from, for a model it runs on the Anthropic API (as src/model.ts does). */
export function keyVariable(model: string): string {
  return model.startsWith("deepseek") ? "DEEPSEEK_API_KEY" : "ANTHROPIC_API_KEY";
}

/**
 * jig's arguments for a task, its prompt to come on stdin (`-`), which keeps it out of the process list. A
 * task with approvals runs in its mode and asks at the service's internal listener (`internalBaseUrl`)
 * before the tool calls that mode doesn't allow; any other runs with --yes.
 */
export function jigArgs(task: Task, tenant: Tenant, paths: { cwd: string; events: string; stats: string; baseUrl: string; internalBaseUrl?: string }): string[] {
  const { model, maxSteps, timeLimit, approvals, mode = "edits" } = task.spec;
  if (approvals && !paths.internalBaseUrl) throw new Error("A task with approvals needs the service's internalBaseUrl, where its jig asks for them");
  const asks = approvals
    ? ["--mode", mode, "--approve-via", `${paths.internalBaseUrl!.replace(/\/+$/, "")}/internal/approvals`, "--approval-timeout", String(tenant.limits.approvalTimeout ?? 600)]
    : ["--yes"];
  return [...asks, "--model", model, "--base-url", paths.baseUrl, "--max-steps", String(maxSteps), "--time-limit", String(timeLimit), "--events", paths.events, "--stats", paths.stats, "-C", paths.cwd, "-"];
}

/** Why a workspace file's path can't be written, or undefined if it lies inside the workspace. */
export function workspaceProblem(path: string): string | undefined {
  if (path === "" || path.includes("\0")) return "is empty or holds a NUL byte";
  if (isAbsolute(path) || /^[\\/]|^[a-zA-Z]:/.test(path)) return "is absolute";
  const parts = path.split(/[\\/]/);
  if (parts.includes("..")) return "leads out of the workspace (..)";
  if (["", "."].includes(parts.at(-1)!)) return "names a folder, not a file";
  return undefined;
}

// jig's exit codes (README: a task given on the command line exits with ...) and the stops they stand for.
const STOPS: Record<number, string> = { 0: "end_turn", 1: "error", 2: "max_steps", 3: "max_tokens", 4: "refusal", 5: "unapproved", 6: "loop", 7: "time_limit", 8: "empty", 130: "interrupted" };

/** The stop an exit code stands for, where the run left no end event to say. */
export function stopFor(exitCode: number | null): string {
  return (exitCode !== null && STOPS[exitCode]) || "error";
}

/**
 * A finished run's status. succeeded: the model finished (0). stopped: the run stopped short at a limit:
 * steps (2), the output limit or context window (3), repeating itself (6), the time limit (7, or the runner's
 * own stop past it), empty replies (8), or an interruption (130). failed: the model declined (4), or tool
 * calls needed approval (5). error: anything else, jig's own failures (1) and an unexplained signal included.
 */
export function statusFor(exit: { exitCode: number | null; timedOut?: boolean; cancelled?: boolean }): TaskStatus {
  if (exit.cancelled) return "cancelled";
  if (exit.timedOut) return "stopped";
  switch (exit.exitCode) {
    case 0:
      return "succeeded";
    case 2:
    case 3:
    case 6:
    case 7:
    case 8:
    case 130:
      return "stopped";
    case 4:
    case 5:
      return "failed";
    default:
      return "error";
  }
}
