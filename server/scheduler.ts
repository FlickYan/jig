import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { type JigEvent, type RunExit, type RunHandle, type Runner, statusFor, stopFor } from "./runner.ts";
import type { Outcome, Store, Task, TaskStatus, Tenant, Usage } from "./store.ts";

// Starts queued tasks as slots free up: never more than `concurrency` at once, nor more of a tenant's than
// its own limit, and round-robin across the tenants with work queued, so one that queues a thousand tasks
// doesn't hold back another's one. The caps are counted in the store, so replicas of the service sharing
// one keep to them together; the round-robin is each replica's own. A run's events go to the store, then
// to whoever follows the task.
//
// A running task is leased to the replica that runs it, which renews the lease while the run goes on: a
// task whose lease ran out has lost its replica (it crashed, or lost the database), and any replica ends it
// as an error.

/** What followers of a task hear: each event once it is stored, then the status it ended with. */
export type Update = { event: JigEvent } | { done: TaskStatus };

export interface SchedulerOptions {
  /** Tasks that may run at once, across the replicas sharing the store. */
  concurrency: number;
  /** This replica's name in the store, which its leases are held under: no two running at once may share it. */
  replicaId?: string;
  /** How long a lease holds unless renewed, in milliseconds; it is renewed every third of that (default 30 s). */
  leaseMs?: number;
  /** The most of a run's events that are stored; past it they are dropped, with one notice (default 10,000). */
  maxEvents?: number;
  /** Keep each task's folder after it ends, instead of removing it. */
  keepTaskDirs?: boolean;
}

interface Run {
  tenant: string;
  handle?: RunHandle;
  /** Why it is being stopped, if it is. */
  stopping?: "cancelled" | "shutdown" | "lost";
  /** Set once its events and exit are in: its outcome is being stored. */
  ended?: boolean;
  /** Settles once the run's outcome is stored. */
  done?: Promise<void>;
}

const SHUTDOWN = "the task service stopped while it ran";
const EXPIRED = `${SHUTDOWN} (the replica running it stopped renewing its lease: it crashed, was killed or lost the database)`;
const LOST = "the replica running it lost its lease on it, and stopped it";

export class Scheduler {
  /** Emits a task's updates under its id. */
  readonly updates = new EventEmitter().setMaxListeners(0);
  readonly replicaId: string;
  private runs = new Map<string, Run>();
  /** Runs that have ended, their outcomes being stored. */
  private recording = new Set<Promise<void>>();
  private ticking: Promise<void> | undefined;
  private again = false;
  private closed = false;
  /** The tenant that got the last slot: the next round starts after it. */
  private lastTenant = "";
  private timer?: NodeJS.Timeout;
  private keeping?: Promise<void>;

  private store: Store;
  private runner: Runner;
  private concurrency: number;
  private leaseMs: number;
  private maxEvents: number;
  private keepTaskDirs: boolean;

  constructor(store: Store, runner: Runner, { concurrency, replicaId, leaseMs = 30_000, maxEvents = 10_000, keepTaskDirs = false }: SchedulerOptions) {
    this.store = store;
    this.runner = runner;
    this.concurrency = concurrency;
    this.replicaId = replicaId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.leaseMs = leaseMs;
    this.maxEvents = maxEvents;
    this.keepTaskDirs = keepTaskDirs;
    store.changes.on("cancel", this.cancelled);
  }

  /** Another replica asked for a cancel: the run is stopped if it is this one's. */
  private cancelled = (id: string) => {
    const run = this.runs.get(id);
    if (!run) return;
    run.stopping ??= "cancelled";
    run.handle?.cancel();
  };

  /**
   * Ends the tasks whose replica is gone, starts what is queued, and from then on, every third of a lease,
   * renews this replica's leases, ends the tasks whose lease ran out and looks for work again.
   */
  async start(): Promise<string[]> {
    const expired = await this.expire();
    this.timer = setInterval(() => void this.keep(), this.leaseMs / 3);
    void this.poke();
    return expired;
  }

  private keep(): Promise<void> {
    // One at a time: a slow database doesn't pile them up.
    this.keeping ??= (async () => {
      try {
        await this.renew();
        await this.expire();
        // A slot another replica freed, or a task it queued, is looked for here.
        void this.poke();
      } catch (err) {
        console.error("jig service: couldn't renew the leases on its runs:", err);
      }
    })().finally(() => (this.keeping = undefined));
    return this.keeping;
  }

  /** Renews the leases on this replica's runs; a run whose task it no longer holds is stopped. */
  private async renew(): Promise<void> {
    const ids = [...this.runs].filter(([, run]) => !run.ended).map(([id]) => id);
    if (!ids.length) return;
    const held = new Map((await this.store.renew(ids, this.replicaId, this.leaseMs)).map(({ id, cancel }) => [id, cancel]));
    for (const id of ids) {
      const run = this.runs.get(id);
      if (!run || run.ended) continue;
      // Its lease ran out while the database couldn't be reached, and another replica ended it.
      if (!held.has(id)) run.stopping ??= "lost";
      // A cancel asked for through another replica, whose notice didn't come.
      else if (held.get(id)) run.stopping ??= "cancelled";
      else continue;
      run.handle?.cancel();
    }
  }

  /** Ends, as errors, the tasks whose lease ran out. */
  private async expire(): Promise<string[]> {
    const expired = await this.store.expire(EXPIRED);
    for (const id of expired) this.updates.emit(id, { done: "error" } satisfies Update);
    return expired;
  }

  /** Looks for work: after a task is queued, and whenever a run ends. */
  poke(): Promise<void> {
    this.again = true;
    this.ticking ??= this.tick().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async tick(): Promise<void> {
    while (this.again && !this.closed) {
      this.again = false;
      // A store that fails now may not later: the next poke tries again.
      await this.fill().catch((err: unknown) => console.error("jig service: couldn't start queued tasks:", err));
    }
  }

  /** Waits until what has happened is acted on: no slot being filled, and no run that ended left unstored. */
  async settled(): Promise<void> {
    do {
      // A run that just ended gets to its recording first.
      await new Promise((done) => setImmediate(done));
      await Promise.all([this.ticking, ...this.recording]);
    } while (this.ticking || this.recording.size);
  }

  /** The status the task is in after the cancel: cancelled at once if queued, later if running. */
  async cancel(task: Task): Promise<TaskStatus> {
    const run = this.runs.get(task.id);
    if (run) {
      run.stopping ??= "cancelled";
      run.handle?.cancel();
      return "running";
    }
    if (task.status === "queued" && (await this.store.cancelQueued(task.id))) {
      this.updates.emit(task.id, { done: "cancelled" } satisfies Update);
      return "cancelled";
    }
    // Running on another replica (or claimed meanwhile): its replica is told, and stops it.
    if (await this.store.requestCancel(task.id)) {
      this.cancelled(task.id);
      return "running";
    }
    return (await this.store.task(task.id))!.status;
  }

  /** Stops every run, marking it an error, and starts no more. */
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.store.changes.off("cancel", this.cancelled);
    for (const run of this.runs.values()) {
      run.stopping ??= "shutdown";
      run.handle?.cancel();
    }
    await Promise.all([...this.runs.values()].map((run) => run.done));
    await this.settled();
    await this.keeping;
  }

  /** The tasks this scheduler is running, by tenant. */
  running(tenant?: string): number {
    return [...this.runs.values()].filter((run) => tenant === undefined || run.tenant === tenant).length;
  }

  // It reads the tenants with work queued and then, a slot at a time, claims the next task of the tenant
  // whose turn it is, never reading the whole queue: a poke must stay cheap however much one tenant has
  // queued.
  private async fill(): Promise<void> {
    if (this.runs.size >= this.concurrency) return;
    // The tenants in order, from the one after the last to get a slot.
    const ids = await this.store.queuedTenants();
    const order = [...ids.filter((id) => id > this.lastTenant), ...ids.filter((id) => id <= this.lastTenant)];
    const tenants = new Map<string, Tenant | undefined>();
    for (const id of order) tenants.set(id, await this.store.tenant(id));
    /** Tenants whose queue has run dry, or that are at their cap. */
    const done = new Set<string>();
    for (let progress = true; progress && this.runs.size < this.concurrency && !this.closed; ) {
      progress = false;
      for (const id of order) {
        if (this.runs.size >= this.concurrency || this.closed) break;
        const tenant = tenants.get(id);
        if (!tenant || done.has(id) || this.running(id) >= tenant.limits.concurrency) continue;
        const terms = { owner: this.replicaId, leaseMs: this.leaseMs, concurrency: this.concurrency, tenantConcurrency: tenant.limits.concurrency };
        const task = await this.store.claim(id, terms);
        // Every slot is taken, here or on other replicas.
        if (task === "full") return;
        if (!task || task === "tenant full") {
          done.add(id);
          continue;
        }
        progress = true;
        this.lastTenant = id;
        const run: Run = { tenant: id };
        this.runs.set(task.id, run);
        run.done = this.run(task, tenant, run);
      }
    }
  }

  private async run(task: Task, tenant: Tenant, run: Run): Promise<void> {
    let exit: RunExit | undefined;
    let failure: string | undefined;
    let end: JigEvent | undefined;
    let stored = 0;
    let dropping = false;
    try {
      run.handle = await this.runner.start(task, tenant);
      if (run.stopping) run.handle.cancel();
      for await (const event of run.handle.events) {
        if (event.type === "end") end = event;
        let kept = event;
        // Past the cap, a run's events are dropped, but for its end, and one notice in place of the first
        // dropped says so: a task's commands can't fill the store, and the run goes on.
        if (stored >= this.maxEvents && event.type !== "end") {
          if (dropping) continue;
          dropping = true;
          kept = { v: 1, seq: event.seq, ts: event.ts, type: "notice", text: `The run's events past ${this.maxEvents} aren't kept: the service drops them, but for the end.` };
        }
        await this.store.addEvent(task.id, kept.seq, kept);
        stored++;
        this.updates.emit(task.id, { event: kept } satisfies Update);
      }
      exit = await run.handle.wait();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      // A run whose events couldn't be read or stored may still be going: it is stopped, and keeps its
      // slot until it has ended, so a failing reader never lets a tenant run more than its limit.
      if (run.handle) {
        run.handle.cancel();
        exit = await run.handle.wait().catch(() => undefined);
      }
    }
    run.ended = true;
    const recorded = this.record(task.id, outcomeOf(exit, end, failure, run.stopping)).catch((err: unknown) => console.error(`jig service: couldn't store how ${task.id} ended:`, err));
    this.recording.add(recorded);
    await recorded.finally(() => this.recording.delete(recorded));
  }

  private async record(id: string, outcome: Outcome): Promise<void> {
    try {
      await this.store.finish(id, this.replicaId, outcome);
      this.updates.emit(id, { done: outcome.status } satisfies Update);
    } finally {
      // The slot is free even if the outcome couldn't be stored: the task's lease, no longer renewed,
      // runs out, and it ends as an error.
      this.runs.delete(id);
      if (!this.closed) void this.poke();
      if (!this.keepTaskDirs) await this.runner.removeFiles?.(id).catch((err: unknown) => console.error(`jig service: couldn't remove ${id}'s folder:`, err));
    }
  }
}

/** A run's outcome: from its exit, its end event (the stop, usage and cost), and why it was stopped. */
export function outcomeOf(exit: RunExit | undefined, end: JigEvent | undefined, failure: string | undefined, stopping: Run["stopping"]): Outcome {
  const status = stopping === "shutdown" || stopping === "lost" ? "error" : stopping === "cancelled" ? "cancelled" : failure ? "error" : statusFor(exit!);
  const exitCode = exit?.exitCode ?? null;
  const stop = typeof end?.stop === "string" ? end.stop : exit?.timedOut ? "time_limit" : exit ? stopFor(exitCode) : null;
  const error =
    stopping === "shutdown" ? SHUTDOWN : stopping === "lost" ? LOST : failure ?? (status === "error" ? `jig exited with ${exitCode ?? "a signal"}${exit?.message ? `: ${exit.message}` : ""}` : null);
  return {
    status,
    exitCode,
    // Both come from what the run wrote (its end event, its last line of output, a clone's errors), which
    // may hold a NUL: Postgres text can't, and the outcome would never be stored.
    stop: stop && withoutNul(stop),
    error: error && withoutNul(error),
    stats: exit?.stats ?? null,
    usage: (end?.usage as Usage | undefined) ?? null,
    cost: typeof end?.cost === "number" ? end.cost : null,
  };
}

/** The text with each NUL character replaced by U+FFFD, which shows something was there. */
function withoutNul(text: string): string {
  return text.replaceAll("\0", "\uFFFD");
}
