import { EventEmitter } from "node:events";
import { type JigEvent, type RunExit, type RunHandle, type Runner, statusFor, stopFor } from "./runner.ts";
import type { Outcome, Store, Task, TaskStatus, Tenant, Usage } from "./store.ts";

// Starts queued tasks as slots free up: never more than `concurrency` at once, nor more of a tenant's than
// its own limit, and round-robin across the tenants with work queued, so one that queues a thousand tasks
// doesn't hold back another's one. A run's events go to the store, then to whoever follows the task.

/** What followers of a task hear: each event once it is stored, then the status it ended with. */
export type Update = { event: JigEvent } | { done: TaskStatus };

interface Run {
  tenant: string;
  handle?: RunHandle;
  /** Why it is being stopped, if it is. */
  stopping?: "cancelled" | "shutdown";
  /** Settles once the run's outcome is stored. */
  done?: Promise<void>;
}

const SHUTDOWN = "the task service stopped while it ran";

export class Scheduler {
  /** Emits a task's updates under its id. */
  readonly updates = new EventEmitter().setMaxListeners(0);
  private runs = new Map<string, Run>();
  /** Runs that have ended, their outcomes being stored. */
  private recording = new Set<Promise<void>>();
  private ticking: Promise<void> | undefined;
  private again = false;
  private closed = false;
  /** The tenant that got the last slot: the next round starts after it. */
  private lastTenant = "";

  private store: Store;
  private runner: Runner;
  private concurrency: number;

  constructor(store: Store, runner: Runner, concurrency: number) {
    this.store = store;
    this.runner = runner;
    this.concurrency = concurrency;
  }

  /** Ends the tasks a stopped or crashed service left running, before anything starts. */
  async recover(): Promise<Task[]> {
    const left = (await this.store.inStatus("running")).filter((task) => !this.runs.has(task.id));
    for (const task of left) await this.store.finish(task.id, { ...EMPTY, status: "error", error: `${SHUTDOWN} (found at the next start)` });
    return left;
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
    return (await this.store.task(task.id))!.status;
  }

  /** Stops every run, marking it an error, and starts no more. */
  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.stopping ??= "shutdown";
      run.handle?.cancel();
    }
    await Promise.all([...this.runs.values()].map((run) => run.done));
    await this.settled();
  }

  /** The tasks this scheduler is running, by tenant. */
  running(tenant?: string): number {
    return [...this.runs.values()].filter((run) => tenant === undefined || run.tenant === tenant).length;
  }

  // It reads the tenants with work queued and then, a slot at a time, the next task of the tenant whose
  // turn it is, never the whole queue: a poke must stay cheap however much one tenant has queued, since
  // the store's calls hold up the whole service while they run.
  private async fill(): Promise<void> {
    if (this.runs.size >= this.concurrency) return;
    // The tenants in order, from the one after the last to get a slot.
    const ids = await this.store.queuedTenants();
    const order = [...ids.filter((id) => id > this.lastTenant), ...ids.filter((id) => id <= this.lastTenant)];
    const tenants = new Map<string, Tenant | undefined>();
    for (const id of order) tenants.set(id, await this.store.tenant(id));
    /** Tenants whose queue has run dry. */
    const empty = new Set<string>();
    for (let progress = true; progress && this.runs.size < this.concurrency && !this.closed; ) {
      progress = false;
      for (const id of order) {
        if (this.runs.size >= this.concurrency || this.closed) break;
        const tenant = tenants.get(id);
        if (!tenant || empty.has(id) || this.running(id) >= tenant.limits.concurrency) continue;
        const task = await this.store.nextQueued(id);
        if (!task) {
          empty.add(id);
          continue;
        }
        progress = true;
        if (!(await this.store.claim(task.id))) continue; // cancelled meanwhile: its next one gets the turn
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
    try {
      run.handle = await this.runner.start(task, tenant);
      if (run.stopping) run.handle.cancel();
      for await (const event of run.handle.events) {
        await this.store.addEvent(task.id, event.seq, event);
        if (event.type === "end") end = event;
        this.updates.emit(task.id, { event } satisfies Update);
      }
      exit = await run.handle.wait();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    const recorded = this.record(task.id, outcomeOf(exit, end, failure, run.stopping)).catch((err: unknown) => console.error(`jig service: couldn't store how ${task.id} ended:`, err));
    this.recording.add(recorded);
    await recorded.finally(() => this.recording.delete(recorded));
  }

  private async record(id: string, outcome: Outcome): Promise<void> {
    await this.store.finish(id, outcome);
    this.runs.delete(id);
    this.updates.emit(id, { done: outcome.status } satisfies Update);
    if (!this.closed) void this.poke();
  }
}

const EMPTY: Outcome = { status: "error", exitCode: null, stop: null, error: null, stats: null, usage: null, cost: null };

/** A run's outcome: from its exit, its end event (the stop, usage and cost), and why it was stopped. */
export function outcomeOf(exit: RunExit | undefined, end: JigEvent | undefined, failure: string | undefined, stopping: Run["stopping"]): Outcome {
  const status = stopping === "shutdown" ? "error" : stopping === "cancelled" ? "cancelled" : failure ? "error" : statusFor(exit!);
  const exitCode = exit?.exitCode ?? null;
  const stop = typeof end?.stop === "string" ? end.stop : exit?.timedOut ? "time_limit" : exit ? stopFor(exitCode) : null;
  const error =
    stopping === "shutdown" ? SHUTDOWN : failure ?? (status === "error" ? `jig exited with ${exitCode ?? "a signal"}${exit?.message ? `: ${exit.message}` : ""}` : null);
  return {
    status,
    exitCode,
    stop,
    error,
    stats: exit?.stats ?? null,
    usage: (end?.usage as Usage | undefined) ?? null,
    cost: typeof end?.cost === "number" ? end.cost : null,
  };
}
