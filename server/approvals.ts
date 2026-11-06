import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { createLog, type Log } from "./log.ts";
import type { JigEvent } from "./runner.ts";
import { type ServiceMetrics, serviceMetrics } from "./service-metrics.ts";
import type { Answer, Approval, ApprovalMode, ApprovalRequest, Given, Store, Task } from "./store.ts";
import { verifyToken } from "./token.ts";

// Approvals over the API (docs/server.md, the approval contract). A task with approvals runs its jig with
// --approve-via instead of --yes: where jig would ask at a terminal before a tool call, it writes an
// approval_request event and long-polls the service's internal listener for the answer, with its gateway
// token. The approval exists once that event is stored; the tenant answers it through the API, and jig's
// own approval event, which says how it was answered in the end (by the API, or its timeout), is the record.
// jig is only ever given the API's answer, though, and an event that says the API answered is kept only if
// it gave that answer: on Docker and Kubernetes a run's commands can write its events.

/** jig's --mode values but auto, which never asks. */
export const APPROVAL_MODES: ApprovalMode[] = ["plan", "ask", "edits"];
/** The longest a long poll is held, in seconds. */
export const MAX_WAIT = 30;

/** The approval an approval_request event asks for, or undefined if it isn't one jig would write. */
export function approvalRequest(event: JigEvent): ApprovalRequest | undefined {
  const { id, step, tool, description } = event;
  if (event.type !== "approval_request" || typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) return undefined;
  // The run writes them, so a NUL (which Postgres text can't hold) is replaced, as in an outcome.
  const text = (value: unknown) => (typeof value === "string" ? value : "").replaceAll("\0", "�");
  return { id, step: Number.isInteger(step) && Math.abs(step as number) < 2 ** 31 ? (step as number) : null, tool: text(tool), description: text(description) };
}

/** The answer an approval event records, with the approval's id, or undefined if it isn't one. */
export function approvalAnswer(event: JigEvent): { id: string; answer: Answer } | undefined {
  const { id, decision, always, by } = event;
  if (event.type !== "approval" || typeof id !== "string" || (decision !== "allow" && decision !== "deny") || (by !== "api" && by !== "timeout")) return undefined;
  // A timeout is a deny: an event that says otherwise isn't one jig would write.
  if (by === "timeout" && decision !== "deny") return undefined;
  return { id, answer: { decision, always: always === true, by } };
}

/**
 * Waits for approvals' answers. A wait is woken by an answer given through this replica, by one the store
 * announces from another, and, while the store can't announce them (SQLite, or a lost connection), by a
 * look every second.
 */
export class Answers {
  private local = new EventEmitter().setMaxListeners(0);
  private store: Store;
  private closing = new AbortController();
  private waits = new Set<Promise<unknown>>();

  constructor(store: Store) {
    this.store = store;
  }

  /** An approval was answered through this replica. */
  answered(task: string, id: string): void {
    this.local.emit("approval", task, id);
  }

  /** The answer jig is given (Store.given) once there is one; undefined if there is none after `ms`, or once `signal` aborts. */
  wait(task: string, id: string, ms: number, signal: AbortSignal): Promise<Given | undefined> {
    const waiting = this.waitFor(task, id, ms, AbortSignal.any([signal, this.closing.signal]));
    this.waits.add(waiting);
    return waiting.finally(() => this.waits.delete(waiting));
  }

  /** Ends the waits, and settles once none reads the store any more. */
  async close(): Promise<void> {
    this.closing.abort();
    await Promise.all(this.waits);
  }

  private async waitFor(task: string, id: string, ms: number, signal: AbortSignal): Promise<Given | undefined> {
    const deadline = Date.now() + ms;
    let changed = false;
    let wake: (() => void) | undefined;
    const heard = (answeredTask: string, answeredId: string) => answeredTask === task && answeredId === id && poke();
    const poke = () => {
      changed = true;
      wake?.();
    };
    // Listened to before the first look, so no answer falls between the two.
    this.local.on("approval", heard);
    this.store.changes.on("approval", heard);
    this.store.changes.on("resync", poke);
    signal.addEventListener("abort", poke);
    try {
      for (;;) {
        changed = false;
        if (signal.aborted) return undefined;
        const given = await this.store.given(task, id);
        const left = deadline - Date.now();
        if (given || left <= 0) return given;
        if (changed) continue;
        await new Promise<void>((done) => {
          const timer = setTimeout(done, this.store.live ? left : Math.min(left, 1000));
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
        wake = undefined;
      }
    } finally {
      this.local.off("approval", heard);
      this.store.changes.off("approval", heard);
      this.store.changes.off("resync", poke);
      signal.removeEventListener("abort", poke);
    }
  }
}

/**
 * The internal listener, which only tasks reach: GET /internal/approvals/<id>?wait=<seconds> with the task's
 * gateway token as its Bearer long-polls (up to MAX_WAIT seconds) for the answer to that approval of the
 * token's task: 200 {decision, always}, or 204 while there is none. The answer is the API's (or a deny once
 * jig's timeout is recorded), never what the run's own events say. And GET /healthz.
 */
export async function handleInternal(req: IncomingMessage, res: ServerResponse, { store, answers, secret }: { store: Store; answers: Answers; secret: string }): Promise<void> {
  const url = new URL(req.url ?? "/", "http://service");
  if (url.pathname === "/healthz") return reply(res, 200, { ok: true });
  const match = /^\/internal\/approvals\/([\w-]{1,100})$/.exec(url.pathname);
  if (!match) return reply(res, 404, { error: "Not found" });
  if (req.method !== "GET") return reply(res, 405, { error: "Use GET" });
  const token = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const payload = token ? verifyToken(secret, token) : new Error("no token");
  if (payload instanceof Error) return reply(res, 401, { error: "A task's gateway token is needed: Authorization: Bearer <token>" }, { "www-authenticate": "Bearer" });
  const task = await store.task(payload.task);
  if (!task || task.tenant !== payload.tenant) return reply(res, 404, { error: "No such task" });
  const wait = Number(url.searchParams.get("wait") ?? 0);
  if (!Number.isFinite(wait) || wait < 0) return reply(res, 400, { error: "wait must be a number of seconds" });
  // A jig that stops waiting (its time limit, an interrupt) lets go of the request: so does the wait.
  const gone = new AbortController();
  res.on("close", () => gone.abort());
  const given = await answers.wait(task.id, match[1], Math.min(wait, MAX_WAIT) * 1000, gone.signal);
  if (res.destroyed) return;
  if (given) return reply(res, 200, given);
  res.writeHead(204).end();
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}

export interface Webhook {
  url: string;
  /** The tenant's webhook secret, which signs each POST. */
  secret: string;
}

/** Tries after a first that fails, and how long each may take. */
const RETRIES = 3;
const ATTEMPT_MS = 10_000;

/**
 * Tells tenants that ask (`approvalWebhook`) of each approval their tasks ask for: a POST of {task, approval},
 * signed with the tenant's secret (x-jig-signature: sha256=<hex HMAC-SHA256 of the body>). Sent in the
 * background, so the run never waits on it, and tried again three times, 1, 2 and 4 seconds apart. A redirect
 * is a failed try, never followed: it could send the signed POST anywhere the service reaches. Each approval
 * is counted once in jig_service_webhook_deliveries_total, delivered or failed.
 */
export class Webhooks {
  private hooks: Map<string, Webhook>;
  private retryMs: number;
  private pending = new Set<AbortController>();
  private log: Log;
  private metrics: ServiceMetrics;
  /** Set by close: a run still draining as the service stops may ask after it, and is posted nothing. */
  private closed = false;

  /** `log` is where a webhook that keeps failing is said (the service's); `metrics` count the deliveries. */
  constructor(hooks: Map<string, Webhook>, retryMs = 1000, log = createLog("service"), metrics = serviceMetrics()) {
    this.hooks = hooks;
    this.retryMs = retryMs;
    this.log = log;
    this.metrics = metrics;
  }

  send(task: Task, approval: Approval): void {
    const hook = this.hooks.get(task.tenant);
    if (!hook || this.closed) return;
    const body = JSON.stringify({ task: task.id, approval });
    const headers = { "content-type": "application/json", "x-jig-signature": `sha256=${createHmac("sha256", hook.secret).update(body).digest("hex")}` };
    const stop = new AbortController();
    this.pending.add(stop);
    void (async () => {
      let last = "";
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          if (attempt) await sleep(this.retryMs * 2 ** (attempt - 1), undefined, { signal: stop.signal });
          const res = await fetch(hook.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(ATTEMPT_MS)]) });
          await res.body?.cancel();
          if (res.ok) return this.metrics.webhookDeliveries.inc({ tenant: task.tenant, result: "delivered" });
          last = res.status >= 300 && res.status < 400 ? `${res.status} (redirects are not followed)` : `${res.status}`;
        } catch (err) {
          if (stop.signal.aborted) return;
          last = err instanceof Error ? err.message : String(err);
        }
      }
      this.metrics.webhookDeliveries.inc({ tenant: task.tenant, result: "failed" });
      this.log.warn(`the approval webhook failed for ${approval.id}, ${RETRIES + 1} times: ${last}`, { tenant: task.tenant, task: task.id });
    })().finally(() => this.pending.delete(stop));
  }

  /** Stops the POSTs still being tried, and sends no more. */
  close(): void {
    this.closed = true;
    for (const stop of this.pending) stop.abort();
  }
}
