import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLog, type Log } from "./log.ts";

// Warm pools (docs/server.md): workers the Docker and Kubernetes runners start ahead of tasks, so a task
// doesn't wait for a container or a pod to start. Each is given a one-time ticket (JIG_POOL_TICKET), which
// this replica keeps only as its hash, with its expiry, and long-polls the internal listener with it (POST
// /internal/pool/claim); the ticket is spent at that first claim. A task that finds a worker waiting is given
// to it, in the claim's answer. A worker runs one task and exits: none is used again, so no tenant's files,
// memory or processes meet another's. One idle for maxIdleSeconds is stopped and another started in its place.

export interface PoolConfig {
  /** Idle workers kept started on this replica (default 0: no pool). */
  size?: number;
  /** Seconds a worker waits for a task before it is stopped and another started in its place (default 600). */
  maxIdleSeconds?: number;
  /** This replica's own internal listener as its workers reach it (default: the service's internalBaseUrl). */
  baseUrl?: string;
}

/** How a worker exited, as far as its runner can tell: its exit code, and the last line it wrote. */
export interface Exited {
  code: number | null;
  said?: string;
}

/** A worker as its runner started it: its container or Job (`slot`), and how to stop it. */
export interface Started<S> {
  slot: S;
  /** Settles once it has exited, or has been stopped, with how it exited if its runner knows. */
  exited: Promise<Exited | void>;
  /** Stops it, and everything it started; again is a no-op. */
  stop(): void;
}

/** A worker taken for a task, its claim held until it is answered. */
export interface Warm<S> extends Started<S> {
  /** Gives the worker its task. False if its claim is no longer held (it went away): it is stopped. */
  answer(body: object): boolean;
}

interface Worker<S> {
  hash: string;
  /** When its ticket expires, in milliseconds. */
  expires: number;
  started?: Started<S>;
  /** Its ticket has been used. */
  spent: boolean;
  /** Being stopped: idle too long, or the service is shutting down. */
  retired: boolean;
  /** Answers its claim, while the claim is held. */
  reply?: (status: number, body: object) => void;
  timer?: NodeJS.Timeout;
}

// The longest a pool waits before it starts workers again after ones that failed before claiming.
const MAX_BACKOFF_MS = 60_000;

export class WarmPool<S> {
  readonly size: number;
  private maxIdleMs: number;
  private launch: (ticket: string) => Promise<Started<S>>;
  /** Every worker started and neither taken nor gone, by its ticket's hash. */
  private workers = new Map<string, Worker<S>>();
  private launching = new Set<Promise<void>>();
  private opened = false;
  private closed = false;
  /** Workers in a row that went before they claimed: the next start waits longer for each. */
  private failures = 0;
  private retry?: NodeJS.Timeout;
  private hits = 0;
  private misses = 0;
  private log: Log;

  /** `launch` starts a worker with its ticket; `log` is where the pool's lines go. */
  constructor({ size = 0, maxIdleSeconds = 600 }: PoolConfig, launch: (ticket: string) => Promise<Started<S>>, log = createLog("service")) {
    this.size = size;
    this.maxIdleMs = maxIdleSeconds * 1000;
    this.launch = launch;
    this.log = log;
  }

  /** Starts filling the pool, once the listener the workers claim at is up. */
  open(): void {
    this.opened = true;
    this.fill();
  }

  /** How many workers wait for a task, how many are starting, and how many tasks one took or started cold. */
  stats(): { size: number; idle: number; starting: number; hits: number; misses: number } {
    const live = [...this.workers.values()].filter((worker) => !worker.retired);
    const idle = live.filter((worker) => worker.reply && worker.started).length;
    return { size: this.size, idle, starting: live.length - idle, hits: this.hits, misses: this.misses };
  }

  /** A worker waiting for a task, taken out of the pool (and another started in its place); undefined if none is. */
  take(task: string): Warm<S> | undefined {
    if (this.closed) return undefined;
    for (const worker of this.workers.values()) {
      const { started, reply } = worker;
      if (!started || !reply || worker.retired) continue;
      this.workers.delete(worker.hash);
      clearTimeout(worker.timer);
      this.fill();
      // A hit once the worker has its task: one that went away first, or that its runner stops before it
      // answers (its Job couldn't be changed), leaves the task to start cold, a miss.
      let settled = false;
      const settle = (hit: boolean) => {
        if (settled) return;
        settled = true;
        if (hit) this.hits++;
        else this.misses++;
      };
      return {
        ...started,
        stop: () => {
          settle(false);
          started.stop();
        },
        answer: (body) => {
          if (!worker.reply) {
            settle(false);
            started.stop();
            return false;
          }
          settle(true);
          worker.reply(200, body);
          return true;
        },
      };
    }
    this.misses++;
    const { idle, starting, hits, misses } = this.stats();
    this.log.info(`no warm worker was waiting for the task, which starts cold (pool: ${idle} idle, ${starting} starting; ${hits} hits, ${misses} misses)`, { task });
    return undefined;
  }

  /**
   * A worker's claim, POST /internal/pool/claim with its ticket as the Bearer: held until a task is given
   * to it (200, the task), or it is stopped (410). 401 for a ticket that isn't one, or is spent, and 410
   * for one that has expired.
   */
  async claim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return reply(res, 405, { error: "Use POST" });
    req.resume();
    const ticket = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const worker = ticket ? this.workers.get(hashOf(ticket)) : undefined;
    // A worker taken or gone is no longer in the pool: its ticket is as spent as a second use of it.
    if (!worker || worker.spent) return reply(res, 401, { error: "A warm worker's unspent ticket is needed: Authorization: Bearer <ticket>" }, { "www-authenticate": "Bearer" });
    if (worker.retired || Date.now() >= worker.expires) return reply(res, 410, { error: "The ticket has expired" });
    worker.spent = true;
    this.failures = 0;
    // The claim may be held for many minutes: keepalive breaks it if the worker's node dies, where it would
    // otherwise look open, and be given a task no one runs.
    req.socket.setKeepAlive(true, 15_000);
    worker.reply = (status, body) => {
      worker.reply = undefined;
      reply(res, status, body);
    };
    // A worker whose claim goes away (it exited, or the connection broke) can't be given a task.
    res.on("close", () => {
      if (!worker.reply) return;
      worker.reply = undefined;
      worker.started?.stop();
    });
  }

  /** Stops the idle workers and those starting, and settles once they are gone: the service is shutting down. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    for (const worker of this.workers.values()) this.retire(worker);
    // A worker still being started is stopped once it is.
    await Promise.all(this.launching);
    await Promise.all([...this.workers.values()].map((worker) => worker.started?.exited));
  }

  /** Starts workers until the pool has its size, counting those starting. */
  private fill(): void {
    if (!this.opened || this.closed || this.retry) return;
    let live = [...this.workers.values()].filter((worker) => !worker.retired).length;
    for (; live < this.size; live++) this.add();
  }

  private add(): void {
    const ticket = randomBytes(32).toString("base64url");
    const worker: Worker<S> = { hash: hashOf(ticket), expires: Date.now() + this.maxIdleMs, spent: false, retired: false };
    this.workers.set(worker.hash, worker);
    worker.timer = setTimeout(() => this.retire(worker), this.maxIdleMs);
    const launching = this.launch(ticket).then(
      (started) => {
        worker.started = started;
        if (worker.retired) started.stop();
        void started.exited.then((exited) => this.gone(worker, exited || undefined));
      },
      (err: unknown) => {
        this.log.error("couldn't start a warm worker", { err });
        this.gone(worker);
      },
    );
    this.launching.add(launching);
    void launching.finally(() => this.launching.delete(launching));
  }

  /** Stops a worker that is idle too long (another takes its place), or at shutdown; its claim is answered 410. */
  private retire(worker: Worker<S>): void {
    if (worker.retired || this.workers.get(worker.hash) !== worker) return;
    worker.retired = true;
    clearTimeout(worker.timer);
    worker.reply?.(410, { error: "The ticket has expired" });
    worker.started?.stop();
    this.fill();
  }

  /** A worker that exited (`exited`, how, if its runner knows), or couldn't be started, while in the pool. */
  private gone(worker: Worker<S>, exited?: Exited): void {
    clearTimeout(worker.timer);
    if (this.workers.get(worker.hash) !== worker) return;
    this.workers.delete(worker.hash);
    if (worker.retired || worker.spent) return this.fill();
    // It went before it claimed: its image can't run, say. Starting it again at once would only loop.
    this.failures++;
    if (this.closed) return;
    const pauseMs = this.retry ? undefined : Math.min(1000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    // What it said last is the one sign of why (a pool URL its container can't reach, say): its folder,
    // output and all, goes with it. One that couldn't be started was logged as such.
    if (worker.started) this.log.warn("a warm worker exited before it claimed a task; the next starts after a pause", { exitCode: exited?.code, output: exited?.said, pauseMs });
    if (pauseMs === undefined) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.fill();
    }, pauseMs);
  }
}

function hashOf(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}
