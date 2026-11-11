import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname } from "node:os";
import { approvalAnswer, approvalRequest } from "./approvals.ts";
import { createLog, type Log } from "./log.ts";
import { PgError } from "./pg.ts";
import { checkedGit, type JigEvent, type RunExit, type RunHandle, type Runner, statusFor, stopFor } from "./runner.ts";
import { type ServiceMetrics, serviceMetrics } from "./service-metrics.ts";
import { type Approval, FINISHED, type Outcome, spentOf, type Store, type Task, type TaskStatus, type Tenant, type Usage } from "./store.ts";

// Starts queued tasks as slots free up: never more than `concurrency` at once, nor more of a tenant's than
// its own limit, and round-robin across the tenants with work queued, so one that queues a thousand tasks
// doesn't hold back another's one. The caps are counted in the store, so replicas of the service sharing
// one keep to them together; the round-robin is each replica's own. A run's events go to the store, then
// to whoever follows the task; an approval it asks for is kept as its event is.
//
// A running task is leased to the replica that runs it, which renews the lease while the run goes on: a
// task whose lease ran out has lost its replica (it crashed, or lost the database), and any replica ends it
// as an error, and has its runner stop the container or Job it may have left running. After a round of
// renewals that failed or hung past two ticks, the next that gets through ends no task, and nor does a start:
// the database may have been away from every replica for longer than a lease, and the others are owed a round
// to renew theirs first. A round slower than a tick, but not two, ends only the tasks whose lease ran out
// before a cut-off it may have hung through could have cost the others theirs.
//
// A run's folder is removed as it ends; one a crashed replica left is removed by the sweep at the next start,
// or every tenth round, once its task has ended over a lease ago, or the store doesn't have it and the folder
// hasn't changed for a lease (ten minutes at least).
//
// With retentionMs, the tasks that ended longer ago than that are purged (Store.purge), at the start and
// every tenth round too: a few at a time, by one replica at a time.

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
  /** The most bytes of a run's events (as JSON) that are stored; past it, as past maxEvents (default 64 MiB). */
  maxEventBytes?: number;
  /** The most bytes of a run's last text that are kept as the task's result; past it, its start is (default 64 KiB). */
  maxResultBytes?: number;
  /** Keep each task's folder after it ends, instead of removing it. */
  keepTaskDirs?: boolean;
  /** Purge the tasks that ended over this many milliseconds ago (the config's retentionDays); none without it. */
  retentionMs?: number;
  /** The hosts a workspace may be cloned from (default: any), checked again as each task starts. */
  gitHosts?: string[];
  /** Called once an approval a run asked for is stored (to tell its tenant), not waited for. */
  onApproval?: (task: Task, approval: Approval) => void;
  /**
   * Called as this replica ends a task (a run's outcome stored, a lease run out, a queued one cancelled), to
   * tell its tenant: not waited for, and it must not throw. One replica wins each end, so each is told once.
   */
  onEnded?: (task: Pick<Task, "id" | "tenant">, status: TaskStatus) => void;
  /** Where its runs, leases and failures are counted (default: a registry of its own, which nothing serves). */
  metrics?: ServiceMetrics;
  log?: Log;
}

interface Run {
  tenant: string;
  /** When this replica claimed it, in milliseconds. */
  claimed: number;
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
/** How long a folder whose task the store doesn't have must be left unchanged before it is swept, at the least. */
const UNKNOWN_MS = 10 * 60_000;
/**
 * The tasks retention purges in one transaction. Few, as SQLite's holds the event loop while it deletes
 * their events: about 0.4 s for a task with 64 MiB of them, so about 2 s at the worst.
 */
const RETAIN_BATCH = 5;

export class Scheduler {
  /** Emits a task's updates under its id. */
  readonly updates = new EventEmitter().setMaxListeners(0);
  readonly replicaId: string;
  private runs = new Map<string, Run>();
  /** Runs that have ended, their outcomes being stored. */
  private recording = new Set<Promise<void>>();
  /** What a gone replica's runs left, being stopped. */
  private abandoning = new Set<Promise<void>>();
  private ticking: Promise<void> | undefined;
  private again = false;
  private closed = false;
  /** Set once the service starts to stop: no task is claimed from then on. */
  private paused = false;
  /** The tenant that got the last slot: the next round starts after it. */
  private lastTenant = "";
  private timer?: NodeJS.Timeout;
  private keeping?: Promise<void>;
  /** Set by a round of renewals that failed or hung past two ticks, until one gets through in time: no task is ended as gone meanwhile. */
  private recovering = false;
  /** The rounds of renewals that got through and ended what was gone: every tenth sweeps the folders. */
  private rounds = 0;
  private sweeping?: Promise<void>;
  private retaining?: Promise<void>;

  private store: Store;
  private runner: Runner;
  private concurrency: number;
  private leaseMs: number;
  private maxEvents: number;
  private maxEventBytes: number;
  private maxResultBytes: number;
  private keepTaskDirs: boolean;
  private retentionMs?: number;
  private gitHosts?: string[];
  private onApproval?: (task: Task, approval: Approval) => void;
  private onEnded?: (task: Pick<Task, "id" | "tenant">, status: TaskStatus) => void;
  private metrics: ServiceMetrics;
  private log: Log;

  constructor(store: Store, runner: Runner, { concurrency, replicaId, leaseMs = 30_000, maxEvents = 10_000, maxEventBytes = 64 * 1024 * 1024, maxResultBytes = 64 * 1024, keepTaskDirs = false, retentionMs, gitHosts, onApproval, onEnded, metrics, log }: SchedulerOptions) {
    this.store = store;
    this.runner = runner;
    this.concurrency = concurrency;
    this.replicaId = replicaId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.leaseMs = leaseMs;
    this.maxEvents = maxEvents;
    this.maxEventBytes = maxEventBytes;
    this.maxResultBytes = maxResultBytes;
    this.keepTaskDirs = keepTaskDirs;
    this.retentionMs = retentionMs;
    this.gitHosts = gitHosts;
    this.onApproval = onApproval;
    this.onEnded = onEnded;
    this.metrics = metrics ?? serviceMetrics();
    this.log = log ?? createLog("service");
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
   * Starts removing the folders runs left (not waited for), starts what is queued, and from then on, every
   * third of a lease, renews this replica's leases, ends the tasks whose lease ran out and looks for work again.
   */
  async start(): Promise<void> {
    await this.store.heartbeat(this.replicaId, this.leaseMs);
    // No task is ended here, but in the first round, a third of a lease on: the database may have just come
    // back from an outage that every replica's leases ran out in (a replica that couldn't start meanwhile
    // starts as it comes back), and the live ones are owed a round to renew theirs.
    // Not waited for: a disk full of left folders, each run stopped in turn, mustn't hold up the API.
    void this.sweep();
    void this.retain();
    this.timer = setInterval(() => void this.keep(), this.leaseMs / 3);
    void this.poke();
  }

  private keep(): Promise<void> {
    // One at a time: a slow database doesn't pile them up.
    this.keeping ??= (async () => {
      const began = Date.now();
      try {
        await this.renew();
        await this.store.heartbeat(this.replicaId, this.leaseMs);
        // The first round through after a failure only renews. Every replica's leases may have run out while
        // the database was away, and the store renews a lapsed lease its replica holds: ending tasks now would
        // end those of the replicas whose round hasn't come yet. A round later, each has had a third of a lease
        // to renew its own, and one that didn't is gone. A round that took longer than two ticks counts as
        // failed: its calls may have hung while the database was cut off (a partition, a paused server) and
        // gone through once it came back, with the others' leases run out just the same. One that took less
        // may be only slow, so it still ends tasks, but not those a cut-off it hung through could have ended:
        // a cut-off began at most a tick before the round (the last one got through), when another replica had
        // renewed its leases at most a tick before. So a lease that ran out within the round's time past a
        // tick may be a live replica's, and is left for a later round. A database always that slow still has
        // a gone replica's tasks ended, that much later.
        const took = Date.now() - began;
        if (took > this.leaseMs / 3) this.log.warn("renewing the leases on its runs took longer than a third of a lease", { ms: took });
        if (took > (2 * this.leaseMs) / 3) this.recovering = true;
        else if (this.recovering) this.recovering = false;
        else {
          await this.expire(Math.max(0, took - this.leaseMs / 3));
          // Not waited for: a slow disk mustn't hold up the renewals.
          if (++this.rounds % 10 === 0) {
            void this.sweep();
            void this.retain();
          }
        }
        // A slot another replica freed, or a task it queued, is looked for here.
        void this.poke();
      } catch (err) {
        this.recovering = true;
        this.metrics.leaseErrors.inc();
        this.log.error("couldn't renew the leases on its runs", { err });
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

  /** Ends, as errors, the tasks whose lease ran out over `graceMs` ago, and stops what their runs left going. */
  private async expire(graceMs = 0): Promise<string[]> {
    const expired = await this.store.expire(EXPIRED, graceMs);
    if (expired.length) this.log.warn(`${expired.length} task(s) whose replica is gone (a crash, or a kill) marked as errors`);
    for (const id of expired) this.updates.emit(id, { done: "error" } satisfies Update);
    // Not waited for here: a slow API server mustn't hold up the renewal of this replica's own leases.
    for (const id of expired) {
      const abandoned = this.runner.abandon?.(id).catch((err: unknown) => this.log.warn("couldn't stop the run of a task whose replica is gone", { task: id, err }));
      if (!abandoned) continue;
      this.abandoning.add(abandoned);
      void abandoned.finally(() => this.abandoning.delete(abandoned));
    }
    // Rare (a replica is gone), so each is read again for its tenant and start, to be counted. They are
    // ended already: one that can't be read goes uncounted (and its tenant untold), and the rest are counted
    // all the same.
    for (const id of expired) {
      const task = await this.store.task(id).catch((err: unknown) => {
        this.metrics.storeErrors.inc({ retried: "false" });
        this.log.error("couldn't read an expired task to count it", { task: id, err });
        return undefined;
      });
      if (!task) continue;
      this.ended(task, "error", task.started && task.ended ? Date.parse(task.ended) - Date.parse(task.started) : undefined);
      this.onEnded?.(task, "error");
    }
    return expired;
  }

  /**
   * Removes the folders runs left on this machine for tasks that ended over a lease ago, or that the store
   * doesn't have: those a replica that crashed, or was killed, never removed. A task that ended within a lease
   * is left to its replica, which removes its folder as it stores its outcome, and a queued or running one's
   * is kept, as replicas may share dataDir. One the store doesn't have is removed only once it hasn't changed
   * for a lease, ten minutes at least, so a run of another service on the same dataDir with a database of its
   * own (which it shouldn't share, docs/server.md) is spared while it writes. What the run may have left going
   * is stopped first. One at a time, stopping at the next folder once the service starts to stop; a failure is
   * logged, and the next sweep tries again.
   */
  private sweep(): Promise<void> {
    if (this.keepTaskDirs || !this.runner.leftovers) return Promise.resolve();
    this.sweeping ??= (async () => {
      for (const { id, changed } of await this.runner.leftovers!()) {
        if (this.paused) break;
        if (this.runs.has(id)) continue;
        const task = await this.store.task(id);
        const left = task ? FINISHED.has(task.status) && task.ended && Date.now() - Date.parse(task.ended) > this.leaseMs : Date.now() - changed > Math.max(this.leaseMs, UNKNOWN_MS);
        if (!left) continue;
        await this.runner.abandon?.(id).catch((err: unknown) => this.log.warn("couldn't stop the run of a task whose folder was left", { task: id, err }));
        try {
          await this.runner.removeFiles?.(id);
          this.metrics.foldersRemoved.inc();
          this.log.info("removed the folder a run left", { task: id });
        } catch (err) {
          this.log.warn("couldn't remove the folder a run left", { task: id, err });
        }
      }
    })()
      .catch((err: unknown) => this.log.error("couldn't look for the folders runs left", { err }))
      .finally(() => (this.sweeping = undefined));
    return this.sweeping;
  }

  /**
   * Purges the tasks that ended over retentionMs ago, RETAIN_BATCH at a time until a batch comes back short:
   * nothing is left, or another replica is at it. The event loop gets a turn between batches, and the service
   * starting to stop ends it after the batch in flight. Beside the folder sweep rather than in it, as that
   * one does nothing with keepTaskDirs. A failure is logged and counted, and the next sweep tries again.
   */
  private retain(): Promise<void> {
    const { retentionMs } = this;
    if (retentionMs === undefined) return Promise.resolve();
    this.retaining ??= (async () => {
      let purged = 0;
      try {
        while (!this.paused) {
          const batch = await this.store.purgeEnded(retentionMs, RETAIN_BATCH);
          purged += batch;
          this.metrics.purged.inc({ reason: "retention" }, batch);
          if (batch < RETAIN_BATCH) break;
          await new Promise((done) => setImmediate(done));
        }
      } catch (err) {
        this.metrics.storeErrors.inc({ retried: "false" });
        this.log.error("couldn't purge the tasks that ended longer ago than retentionDays", { err });
      }
      if (purged) this.log.info(`purged ${purged} task(s) that ended longer ago than retentionDays`);
    })().finally(() => (this.retaining = undefined));
    return this.retaining;
  }

  /** Counts a task that this replica ended, and how long it ran (in milliseconds) if it started. */
  private ended(task: Task, status: TaskStatus, ms?: number): void {
    this.metrics.ended.inc({ tenant: task.tenant, status });
    if (ms !== undefined) this.metrics.runSeconds.observe({ status }, Math.max(0, ms) / 1000);
    this.log.debug("task ended", { tenant: task.tenant, task: task.id, status });
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
      await this.fill().catch((err: unknown) => {
        this.metrics.storeErrors.inc({ retried: "false" });
        this.log.error("couldn't start queued tasks", { err });
      });
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
      this.ended(task, "cancelled");
      this.onEnded?.(task, "cancelled");
      return "cancelled";
    }
    // Running on another replica (or claimed meanwhile): its replica is told, and stops it.
    if (await this.store.requestCancel(task.id)) {
      this.cancelled(task.id);
      return "running";
    }
    return (await this.store.task(task.id))!.status;
  }

  /**
   * Claims no more tasks, while the runs going on go on (their leases renewed): what is queued, or posted
   * meanwhile, stays queued for another replica or the next start.
   */
  pause(): void {
    this.paused = true;
  }

  /** Stops every run, marking it an error, and starts no more. */
  async close(): Promise<void> {
    this.closed = this.paused = true;
    clearInterval(this.timer);
    this.store.changes.off("cancel", this.cancelled);
    // A claim in flight starts its run: that one is stopped with the rest.
    await this.ticking;
    for (const run of this.runs.values()) {
      run.stopping ??= "shutdown";
      run.handle?.cancel();
    }
    await Promise.all([...this.runs.values()].map((run) => run.done));
    await this.settled();
    await this.keeping;
    await this.sweeping;
    await this.retaining;
    await Promise.all(this.abandoning);
    // Counted no more among the replicas up; one that can't say so is forgotten when its heartbeat runs out.
    await this.store.leave(this.replicaId).catch(() => {});
  }

  /** The tasks this scheduler is running, by tenant. */
  running(tenant?: string): number {
    return [...this.runs.values()].filter((run) => tenant === undefined || run.tenant === tenant).length;
  }

  // It reads the tenants with work queued and then, a slot at a time, claims the next task of the tenant
  // whose turn it is, never reading the whole queue: a poke must stay cheap however much one tenant has
  // queued.
  private async fill(): Promise<void> {
    if (this.paused || this.runs.size >= this.concurrency) return;
    // The tenants in order, from the one after the last to get a slot.
    const ids = await this.store.queuedTenants();
    const order = [...ids.filter((id) => id > this.lastTenant), ...ids.filter((id) => id <= this.lastTenant)];
    const tenants = new Map<string, Tenant | undefined>();
    for (const id of order) tenants.set(id, await this.store.tenant(id));
    /** Tenants whose queue has run dry, or that are at their cap. */
    const done = new Set<string>();
    for (let progress = true; progress && this.runs.size < this.concurrency && !this.paused; ) {
      progress = false;
      for (const id of order) {
        if (this.runs.size >= this.concurrency || this.paused) break;
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
        this.metrics.queueSeconds.observe({}, Math.max(0, Date.parse(task.started!) - Date.parse(task.created)) / 1000);
        this.log.debug("task started", { tenant: id, task: task.id });
        const run: Run = { tenant: id, claimed: Date.now() };
        this.runs.set(task.id, run);
        run.done = this.run(task, tenant, run);
      }
    }
  }

  private async run(task: Task, tenant: Tenant, run: Run): Promise<void> {
    let exit: RunExit | undefined;
    let failure: string | undefined;
    let end: JigEvent | undefined;
    /** The run's last text so far, cut to size: the task's result. */
    let said: Said | undefined;
    let stored = 0;
    /** The bytes of the events stored, as JSON. */
    let bytes = 0;
    /** The cap the run's events went past, as the notice gives it: once it is set, they are dropped. */
    let past: string | undefined;
    let noticed = false;
    /** Past a cap, the run's latest event if it is an end: stored after the last event, unless one follows it. */
    let held: JigEvent | undefined;
    // When jig asked for each approval this run stored, by its own clock, to time a timeout's wait.
    const asked = new Map<string, number>();
    try {
      run.handle = await this.runner.start(this.cloneable(task), tenant);
      if (run.stopping) run.handle.cancel();
      // With a pool, whether a warm worker took it; and how long jig took to start, either way.
      const start = run.handle.warm ? "warm" : "cold";
      if (this.runner.pool) this.metrics.poolTakes.inc({ result: run.handle.warm ? "hit" : "miss" });
      for await (const event of run.handle.events) {
        if (!stored) this.metrics.startSeconds.observe({ start }, (Date.now() - run.claimed) / 1000);
        if (event.type === "end") end = event;
        // Taken before the caps below, so a run whose events are dropped still leaves what it said last.
        if (event.type === "text" && typeof event.text === "string") said = resultOf(event.text, this.maxResultBytes);
        let kept = event;
        // Past either cap, a run's events are dropped, but for its last event if that is an end (jig writes
        // its own last), and one notice in place of the first dropped says so: a task's commands can't fill
        // the store with one task, and the run goes on. Lines of up to 1 MiB are read, so the bytes are capped
        // as well as the count. An end counts as any event does, as a task's commands may write ends too.
        if (!past) {
          const size = Buffer.byteLength(JSON.stringify(event));
          past = stored >= this.maxEvents ? `${this.maxEvents}` : bytes + size > this.maxEventBytes ? `${this.maxEventBytes} bytes` : undefined;
          if (!past) bytes += size;
        }
        if (past) {
          // An end held is dropped once another event comes; this one is held in its place if it is an end.
          const dropped = held ?? (event.type === "end" ? undefined : event);
          held = event.type === "end" ? event : undefined;
          if (noticed || !dropped) continue;
          noticed = true;
          kept = { v: 1, seq: dropped.seq, ts: dropped.ts, type: "notice", text: `The run's events past ${past} aren't kept: the service drops them, but for its last event if it is an end.` };
        }
        // The approval first, so it can be answered by whoever sees its event; one past the cap isn't kept,
        // and jig's wait for it ends at its timeout, as a deny. Each write is tried again on a failure,
        // which is safe as each is kept once however often it is made.
        const request = approvalRequest(kept);
        // A try whose write was made but whose reply was lost leaves the next one undefined, as the approval
        // is kept already: it is stored, and can be answered, but its webhook isn't sent.
        const approval = request && (await this.retrying(() => this.store.addApproval(task.id, request), run));
        if (approval) asked.set(approval.id, Date.parse(kept.ts));
        await this.retrying(() => this.store.addEvent(task.id, kept.seq, kept), run);
        stored++;
        // jig's own word on how it was answered is the record, but for an answer by the API it never gave:
        // a run's commands may write its events (on Docker and Kubernetes), so that one is only logged.
        const answered = approvalAnswer(kept);
        const recorded = answered && (await this.retrying(() => this.store.recordApproval(task.id, answered.id, answered.answer), run));
        if (answered && !recorded && answered.answer.by === "api") {
          const said = `${answered.answer.decision}${answered.answer.always ? " always" : ""}`;
          this.log.warn(`the run says the API answered ${answered.id} with ${said}, which it didn't: left out of the record`, { tenant: task.tenant, task: task.id });
        }
        // An answer through the API is counted as it is given (api.ts); a timeout, as jig records it.
        if (recorded && answered.answer.by === "timeout") await this.waited(task.id, answered.id, Date.parse(kept.ts) - (asked.get(answered.id) ?? NaN), run).catch(() => this.metrics.storeErrors.inc({ retried: "false" }));
        this.updates.emit(task.id, { event: kept } satisfies Update);
        if (approval) this.onApproval?.(task, approval);
      }
      if (held) {
        const last = held;
        await this.retrying(() => this.store.addEvent(task.id, last.seq, last), run);
        this.updates.emit(task.id, { event: last } satisfies Update);
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
    // Each failure to store it is counted as it is tried again.
    const recorded = this.record(task, run, outcomeOf(exit, end, failure, run.stopping, said)).catch((err: unknown) => {
      this.log.error("couldn't store how the task ended", { tenant: task.tenant, task: task.id, err });
    });
    this.recording.add(recorded);
    await recorded.finally(() => this.recording.delete(recorded));
  }

  /**
   * The task as its runner is to start it: one queued before gitHosts was set, or listed fewer hosts, is
   * checked again here, and its workspace.git given as it was checked; one no longer allowed throws.
   */
  private cloneable(task: Task): Task {
    const git = task.spec.workspace?.git;
    if (git === undefined) return task;
    const checked = checkedGit(git, this.gitHosts);
    if ("error" in checked) throw new Error(`${checked.error} (checked again as the task started)`);
    return checked.git === git ? task : { ...task, spec: { ...task.spec, workspace: { ...task.spec.workspace, git: checked.git } } };
  }

  /**
   * Counts how long an approval jig's timeout denied waited: `ms` from its two events, by jig's clock, as
   * the service stores each a poll or so after jig writes it, and the two delays differ. A run's commands
   * may write its events, so a wait that isn't a number, or is longer than the run has run, is the
   * stored approval's instead.
   */
  private async waited(task: string, id: string, ms: number, run: Run): Promise<void> {
    if (ms >= 0 && ms <= Date.now() - run.claimed) {
      this.metrics.approvalWait.observe({ decision: "timeout" }, ms / 1000);
      return;
    }
    const approval = await this.store.approval(task, id);
    if (approval?.decidedAt) this.metrics.approvalWait.observe({ decision: "timeout" }, Math.max(0, Date.parse(approval.decidedAt) - Date.parse(approval.requestedAt)) / 1000);
  }

  /**
   * Runs `write`, and on a failure (a dropped connection, a failover) runs it again, waiting 100 ms and then
   * twice as long each time, up to 2 s, until half a lease has gone by since the first try began, or the run,
   * still going, is being stopped; then its error is thrown. Half a lease from the first try's start, as a try
   * can hang (up to the pool's query timeout) before it fails: an ended run's lease is no longer renewed, but
   * was renewed a third of a lease or less before the run ended (when the renewals went through), so the run
   * still holds it when the last try is begun. A try begun may end past the lease, which the store checks: an
   * outcome stored after another replica ended the task isn't stored. An ended run's outcome is tried for all
   * of that, however it was stopped, as it holds what the run spent. An error the database says is in the data
   * (a value out of range, a constraint broken) is thrown at once, as it would fail every time. Each failure
   * is counted, as retried or as given up on. The write must be one that is kept once however often it is
   * made, as one that failed may have been made.
   */
  private async retrying<T>(write: () => Promise<T>, run: Run): Promise<T> {
    const deadline = Date.now() + this.leaseMs / 2;
    for (let wait = 100; ; wait = Math.min(wait * 2, 2000)) {
      try {
        return await write();
      } catch (err) {
        const left = deadline - Date.now();
        const givenUp = left <= 0 || (run.stopping && !run.ended) || permanent(err);
        this.metrics.storeErrors.inc({ retried: givenUp ? "false" : "true" });
        if (givenUp) throw err;
        await new Promise((done) => setTimeout(done, Math.min(wait, left)));
      }
    }
  }

  private async record(task: Task, run: Run, outcome: Outcome): Promise<void> {
    const { id, tenant } = task;
    try {
      // One this replica no longer held was ended by another, which counted it. Tried again on a failure
      // while the slot is held, so the limits hold; a task given up on ends when its lease runs out. A try
      // whose write was made but whose reply was lost leaves the next one false, as the task has ended: the
      // outcome and the ledger are right, but the task isn't counted in the metrics, nor its cost, and its
      // tenant isn't told of the end.
      if (await this.retrying(() => this.store.finish(id, this.replicaId, outcome), run)) {
        this.ended(task, outcome.status, Date.now() - run.claimed);
        const spent = spentOf(outcome);
        if (spent.costUsd) this.metrics.cost.inc({ tenant }, spent.costUsd);
        for (const [kind, n] of [["input", spent.input], ["output", spent.output], ["cache_read", spent.cacheRead], ["cache_write", spent.cacheWrite]] as const) if (n) this.metrics.tokens.inc({ tenant, kind }, n);
        this.onEnded?.(task, outcome.status);
      }
      this.updates.emit(id, { done: outcome.status } satisfies Update);
    } finally {
      // The slot is free even if the outcome couldn't be stored: the task's lease, no longer renewed,
      // runs out, and it ends as an error.
      this.runs.delete(id);
      if (!this.closed) void this.poke();
      if (!this.keepTaskDirs) await this.runner.removeFiles?.(id).catch((err: unknown) => this.log.warn("couldn't remove the task's folder", { tenant, task: id, err }));
    }
  }
}

/** A run's last text as its task keeps it, and whether that is only its start. */
export interface Said {
  text: string;
  truncated: boolean;
}

/**
 * A text as a task's result: with no NUL, and whole if it is `maxBytes` of UTF-8 or fewer, else its start,
 * up to the last character that ends within them. The NULs go first, as U+FFFD is three bytes where a NUL
 * was one: the bound is on what is stored.
 */
export function resultOf(text: string, maxBytes: number): Said {
  const clean = withoutNul(text);
  if (Buffer.byteLength(clean) <= maxBytes) return { text: clean, truncated: false };
  const buf = Buffer.from(clean);
  let end = maxBytes;
  // A byte of the form 10xxxxxx continues a character: the cut steps back to where one starts.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString(), truncated: true };
}

/**
 * A run's outcome: from its exit, its end event (the stop, usage and cost), why it was stopped, and the
 * last text it wrote (the result), however it ended.
 */
export function outcomeOf(exit: RunExit | undefined, end: JigEvent | undefined, failure: string | undefined, stopping: Run["stopping"], said?: Said): Outcome {
  const status = stopping === "shutdown" || stopping === "lost" ? "error" : stopping === "cancelled" ? "cancelled" : failure ? "error" : statusFor(exit!);
  const exitCode = exit?.exitCode ?? null;
  // A run that was stopped and wrote no end of its own (jig, sent SIGTERM, exits 143 without one) was interrupted.
  const stop = typeof end?.stop === "string" ? end.stop : stopping ? "interrupted" : exit?.timedOut ? "time_limit" : exit ? stopFor(exitCode) : null;
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
    result: said?.text ?? null,
    resultTruncated: said?.truncated ?? false,
  };
}

/**
 * Whether a store's error would come again however often the write is made: Postgres's SQLSTATE classes 22
 * (a data exception, such as a number out of range) and 23 (an integrity constraint broken).
 */
function permanent(err: unknown): boolean {
  return err instanceof PgError && /^2[23]/.test(err.code);
}

/** The text with each NUL character replaced by U+FFFD, which shows something was there. */
function withoutNul(text: string): string {
  return text.replaceAll("\0", "\uFFFD");
}
