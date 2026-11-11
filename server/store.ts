import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PoolOptions, PoolStats } from "./pg.ts";

// The task service's state: tenants and their API keys, tasks, each task's events and the approvals its jig
// asked for. Two stores keep to
// one interface: SQLite, through node:sqlite, here, for one replica; and Postgres (store-pg.ts), which
// several replicas share.

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "stopped" | "cancelled" | "error";
export const STATUSES: TaskStatus[] = ["queued", "running", "succeeded", "failed", "stopped", "cancelled", "error"];
/** The statuses a task ends in: it changes no more. */
export const FINISHED: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "stopped", "cancelled", "error"]);

export interface Limits {
  /** Tasks of the tenant's that may run at once. */
  concurrency: number;
  maxSteps: number;
  /** Seconds. */
  timeLimit: number;
  /** The most one task may spend, in USD, which the gateway holds it to; null: no limit. */
  budgetUsd: number | null;
  /** Tasks of the tenant's that may wait in the queue at once; the service's default when missing. */
  maxQueued?: number;
  /** Seconds a task with approvals waits for an answer before its jig takes it as a deny (default 600). */
  approvalTimeout?: number;
  /** What the tenant may start in a UTC day, and spend in a UTC day or month: none when missing. */
  quotas?: Quotas;
  /** Event streams of the tenant's that may be open at once on each replica; the service's default when missing. */
  maxStreams?: number;
}

export interface Quotas {
  /** Tasks created in a UTC day, whatever became of them. */
  tasksPerDay?: number;
  /** USD spent by the tasks that ended in a UTC day, from the usage ledger. */
  usdPerDay?: number;
  usdPerMonth?: number;
}

/** A cap a new task is refused at: the queue's, or one of the quotas. */
export type Cap = "maxQueued" | keyof Quotas;
const CAPS: Cap[] = ["maxQueued", "tasksPerDay", "usdPerDay", "usdPerMonth"];

/** The caps a new task must keep within, checked with its insert (Store.createTask), and the time it is made at. */
export interface Caps extends Quotas {
  maxQueued?: number;
  now: Date;
}

/** Why a new task was refused: the cap, its limit and what the tenant has used of it. */
export interface Refusal {
  quota: Cap;
  limit: number;
  used: number;
}

/** A create's Idempotency-Key, and the SHA-256 (hex) of the body it came with. */
export interface Idempotency {
  key: string;
  hash: string;
}

/** The task an earlier create with the same key made, and whether that create's body was this one's. */
export interface Replay {
  replay: Task;
  same: boolean;
}

/** How long a key answers with its task, from the create that made it. */
export const IDEMPOTENCY_MS = 24 * 3600_000;

/** Whether a key recorded at `created` no longer holds at `now`, in either store. */
export function expired(created: string | Date, now: Date): boolean {
  return now.getTime() - new Date(created).getTime() >= IDEMPOTENCY_MS;
}

/** What a tenant has used of its caps at a moment (Store.standing), and how many of its tasks are running. */
export interface Standing {
  queued: number;
  running: number;
  /** Tasks created in the UTC day, whatever became of them. */
  tasksToday: number;
  /** USD spent by the tasks that ended in the UTC day, and in the UTC month. */
  usdToday: number;
  usdThisMonth: number;
}

/** What the metrics read from the store at a scrape: the same on every replica sharing it. */
export interface Counts {
  /** Queued and running tasks by tenant, with when the oldest of them was created (an ISO time). */
  tasks: { tenant: string; status: "queued" | "running"; count: number; oldest: string }[];
  /** Approvals of running tasks with no answer yet. */
  pendingApprovals: number;
  /** Replicas whose heartbeat hasn't run out. */
  replicas: number;
}

/** A row of the usage report: the ended tasks of a tenant, day or model (those it is grouped by), summed. */
export interface UsageRow {
  tenant?: string;
  day?: string;
  model?: string;
  tasks: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  seconds: number;
}

export interface UsageQuery {
  /** UTC days, YYYY-MM-DD, both included. */
  from: string;
  to: string;
  /** What the rows are by, in this order; the tenant before them with `byTenant`. */
  group: ("day" | "model")[];
  byTenant?: boolean;
  /** Only this tenant's usage. */
  tenant?: string;
}

export interface Tenant {
  id: string;
  limits: Limits;
}

/** A task's files: given, or cloned from a git repository (one or the other). */
export interface Workspace {
  files?: Record<string, string>;
  git?: string;
  ref?: string;
}

/** jig's --mode values a task with approvals may run in: auto never asks. */
export type ApprovalMode = "plan" | "ask" | "edits";

export interface TaskSpec {
  prompt: string;
  workspace?: Workspace;
  maxSteps: number;
  timeLimit: number;
  model: string;
  /** Ask before the tool calls `mode` doesn't allow, through the API, rather than run with --yes. */
  approvals?: boolean;
  mode?: ApprovalMode;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface Task {
  id: string;
  tenant: string;
  spec: TaskSpec;
  status: TaskStatus;
  exitCode: number | null;
  /** How jig's run ended (end_turn, max_steps, time_limit, ...), from its end event or its exit code. */
  stop: string | null;
  error: string | null;
  created: string;
  started: string | null;
  ended: string | null;
  stats: unknown;
  usage: Usage | null;
  cost: number | null;
  /** The last text the run wrote, cut to the service's maxResultBytes; null if it wrote none. */
  result: string | null;
  /** Whether the result is only the start of that text. */
  resultTruncated: boolean;
  /** When its content was deleted (Store.purge), by a DELETE or by retention; null while it is kept. */
  purged: string | null;
}

/** What a finished run leaves on its task. */
export interface Outcome {
  status: TaskStatus;
  exitCode: number | null;
  stop: string | null;
  error: string | null;
  stats: unknown;
  usage: Usage | null;
  cost: number | null;
  /** The run's last text, already cut to size, with no NUL (Postgres text can't hold one); none when left out. */
  result?: string | null;
  resultTruncated?: boolean;
}

export type Decision = "allow" | "deny";

/** What a task's jig asked before a tool call: its approval_request event. */
export interface ApprovalRequest {
  /** ap_<n>, unique within the run. */
  id: string;
  step: number | null;
  tool: string;
  description: string;
}

/** How an approval was answered: by the tenant, through the API, or by jig's own timeout. */
export interface Answer {
  decision: Decision;
  always: boolean;
  by: "api" | "timeout";
}

/** The answer jig is given at the internal listener: {decision, always}. */
export interface Given {
  decision: Decision;
  always: boolean;
}

/** An approval, with its answer once it has one. */
export interface Approval extends ApprovalRequest {
  requestedAt: string;
  decision?: Decision;
  always?: boolean;
  by?: Answer["by"];
  decidedAt?: string;
}

/** A claim's terms: who runs the task, for how long its lease holds, and the caps it must stay within. */
export interface ClaimTerms {
  /** The replica that will run it. */
  owner: string;
  /** How long the lease holds unless renewed, in milliseconds. */
  leaseMs: number;
  /** The most tasks that may run at once in all, across the replicas sharing the store. */
  concurrency: number;
  /** The most of the tenant's that may. */
  tenantConcurrency: number;
}

/**
 * What the replicas sharing a store did, as this one hears it: "event" (task, seq) when an event is stored,
 * "done" (task, status) when a task ends, "cancel" (task) when a cancel is asked for, "approval" (task, id)
 * when an approval is answered, and "resync" () when some may have been missed (the connection that hears
 * them came back).
 */
export type Changes = EventEmitter;

export interface TasksQuery {
  status?: TaskStatus[];
  limit?: number;
  before?: string;
  prompts?: boolean;
}

export interface Store {
  /** Adds the tenant, or updates its limits; its API keys (SHA-256 hashes, in hex) become these. */
  putTenant(tenant: Tenant, keyHashes: string[]): Promise<void>;
  tenant(id: string): Promise<Tenant | undefined>;
  tenantByKey(keyHash: string): Promise<Tenant | undefined>;
  /**
   * Shuts out the tenants not in `keep`: removes their API keys and cancels their queued tasks. How many
   * tasks it cancelled.
   */
  retireTenants(keep: string[]): Promise<number>;
  createTask(tenant: string, spec: TaskSpec): Promise<Task>;
  /**
   * Adds the task unless the tenant is at one of the caps: the refusal for the first it is at, in the order
   * maxQueued, tasksPerDay, usdPerDay, usdPerMonth. The count and the insert are one replica's at a time, so
   * replicas sharing the store can't both admit the tenant's last task of the day.
   *
   * With `idem`, a key the tenant used in the last IDEMPOTENCY_MS answers with the task it made then, before
   * the caps are looked at, and makes none; a new key is recorded with the task, in its transaction. A
   * refusal records nothing.
   */
  createTask(tenant: string, spec: TaskSpec, caps: Caps, idem?: Idempotency): Promise<Task | Refusal | Replay>;
  task(id: string): Promise<Task | undefined>;
  /**
   * What the tenant has used of its caps at `now`, counted as createTask counts them but outside its lock:
   * a task being admitted meanwhile may be missing from it.
   */
  standing(tenant: string, now: Date): Promise<Standing>;
  /**
   * A tenant's tasks, newest first, at most `limit`, those in one of `status` if it is given, those older
   * than the task `before` if it is given; without their prompts (an empty string in their place) and results (null) unless
   * `prompts`.
   */
  tasks(tenant: string, options?: TasksQuery): Promise<Task[]>;
  /** Every tenant's tasks in a status, oldest first. */
  inStatus(status: TaskStatus): Promise<Task[]>;
  /** The tenants with tasks queued, by id. */
  queuedTenants(): Promise<string[]>;
  /**
   * Moves the tenant's oldest queued task to running, leased to `terms.owner`, unless as many tasks as
   * `terms.concurrency` run already ("full"), or as many of the tenant's as its own ("tenant full"); the
   * running ones are counted in the store, so replicas sharing it keep to the caps together. Undefined if
   * nothing of the tenant's is queued.
   */
  claim(tenant: string, terms: ClaimTerms): Promise<Task | "full" | "tenant full" | undefined>;
  /** Extends the owner's leases on these running tasks; those it still holds, and whether a cancel was asked for. */
  renew(ids: string[], owner: string, leaseMs: number): Promise<{ id: string; cancel: boolean }[]>;
  /** Ends, as errors, the running tasks whose lease ran out over `graceMs` ago (0): their replica is gone. Their ids. */
  expire(error: string, graceMs?: number): Promise<string[]>;
  /** Asks the replica running the task to cancel it; false if it isn't running. */
  requestCancel(id: string): Promise<boolean>;
  /** Moves a queued task to cancelled; false if it was no longer queued. */
  cancelQueued(id: string): Promise<boolean>;
  /**
   * Ends a running task, if the owner still holds it: false if it doesn't. Every way a task ends (this,
   * expire, cancelQueued and retireTenants) writes its row of the usage ledger in the same transaction, once.
   */
  finish(id: string, owner: string, outcome: Outcome): Promise<boolean>;
  /** Keeps one of a task's events; one with a seq already kept is ignored. */
  addEvent(task: string, seq: number, event: object): Promise<void>;
  /**
   * A task's events after seq `after`, in order: the first `limit` of them, if it is given. With `bytes`, it
   * stops sooner, after the event that takes their JSON (as stored, in UTF-8) to `bytes`.
   */
  events(task: string, after?: number, limit?: number, bytes?: number): Promise<{ seq: number; event: object }[]>;
  /** Keeps an approval a task's jig asked for; undefined if the task has one with its id already. */
  addApproval(task: string, request: ApprovalRequest): Promise<Approval | undefined>;
  approval(task: string, id: string): Promise<Approval | undefined>;
  /** A task's approvals, in the order they were asked for. */
  approvals(task: string): Promise<Approval[]>;
  /** Answers an approval that has no answer yet: the approval, or undefined if there is no such one. */
  decideApproval(task: string, id: string, answer: Answer): Promise<Approval | undefined>;
  /**
   * Keeps jig's own record of an approval's answer (its approval event), in place of any other: a timeout,
   * or an answer by the API that is the one the API gave. False if it isn't kept.
   */
  recordApproval(task: string, id: string, answer: Answer): Promise<boolean>;
  /** The answer jig is given: the API's, or a deny once jig's timeout is recorded; undefined while there is none. */
  given(task: string, id: string): Promise<Given | undefined>;
  /** How many of each task's approvals have no answer yet; a task with none is left out. */
  pendingApprovals(tasks: string[]): Promise<Map<string, number>>;
  /**
   * Deletes an ended task's content, in one transaction: its events and approvals, its prompt (left empty),
   * its error, stats and result, and its spec but for slimSpec's fields. Its row stays, with its status,
   * times, usage and cost, and so do its row of the usage ledger and its Idempotency-Key. Undefined if there
   * is no such task; one that hasn't ended is left as it is, and comes back with `purged` null. `first` says
   * this call is the one that purged it: a task purged already is purged again, and keeps its time.
   */
  purge(id: string): Promise<{ task: Task; first: boolean } | undefined>;
  /**
   * Purges the tasks that ended over `olderThanMs` ago, by the store's clock, and aren't purged yet: the
   * oldest `limit` of them, in one transaction. How many it purged; on Postgres, 0 while another replica is
   * at it.
   */
  purgeEnded(olderThanMs: number, limit: number): Promise<number>;
  /** Deletes the Idempotency-Keys that no longer hold at `now` (IDEMPOTENCY_MS after their create). How many. */
  forgetKeys(now: Date): Promise<number>;
  /** The usage ledger summed by the query's groups, sorted by them; a group with no ended task is left out. */
  usage(query: UsageQuery): Promise<UsageRow[]>;
  /** Says the replica is up for `ms` more, and forgets those whose heartbeat ran out. */
  heartbeat(replica: string, ms: number): Promise<void>;
  /** Forgets the replica: it is stopping. */
  leave(replica: string): Promise<void>;
  /** The tasks queued and running, the approvals waiting and the replicas up, across the store. */
  counts(): Promise<Counts>;
  /** What other replicas did, as it happens; a store that can't hear it never emits. */
  readonly changes: Changes;
  /** Whether changes are heard as they happen now: if not, whoever waits on them must look again itself. */
  readonly live: boolean;
  /** Asks the database something trivial: throws if it can't answer (the service's /readyz). */
  ping?(): Promise<void>;
  /** The connections to the database, for a store that pools them (Postgres's). */
  poolStats?(): PoolStats;
  close(): Promise<void>;
}

/** What sizes Postgres's pool (the config's databasePool); its other options stay the pool's defaults. */
export type DatabasePool = Pick<PoolOptions, "max" | "acquireTimeoutMs">;

/**
 * Opens the store: Postgres for a postgres:// URL, else SQLite at the path (":memory:" for one in memory).
 * With a region, the ids of the tasks it makes carry it; `pool` sizes Postgres's pool of connections.
 */
export async function openStore(database: string, { region, pool }: { region?: string; pool?: DatabasePool } = {}): Promise<Store> {
  if (/^postgres(ql)?:\/\//.test(database)) return (await import("./store-pg.ts")).PostgresStore.open(database, region, pool);
  return new SqliteStore(database, region);
}

// Each entry moves the schema one version on (PRAGMA user_version counts them). Never edit one that has
// shipped: add another.
const MIGRATIONS = [
  `CREATE TABLE tenants (id TEXT PRIMARY KEY, limits TEXT NOT NULL);
   CREATE TABLE api_keys (hash TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants (id));
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, tenant TEXT NOT NULL REFERENCES tenants (id), prompt TEXT NOT NULL, spec TEXT NOT NULL,
     status TEXT NOT NULL, exit_code INTEGER, stop TEXT, error TEXT,
     created TEXT NOT NULL, started TEXT, ended TEXT, stats TEXT, usage TEXT, cost REAL);
   CREATE INDEX tasks_by_status ON tasks (status);
   CREATE INDEX tasks_by_tenant ON tasks (tenant, status);
   CREATE TABLE events (task TEXT NOT NULL REFERENCES tasks (id), seq INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (task, seq));`,
  // Leases: the replica running a task, until when, and whether another asked it to cancel.
  `ALTER TABLE tasks ADD COLUMN owner TEXT;
   ALTER TABLE tasks ADD COLUMN lease_until TEXT;
   ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;`,
  // The approvals a task's jig asked for, and their answers: the API's (api_*), which only an answer
  // through the API sets and jig is given, and the record (decision to decided_at), which jig's own
  // approval event replaces.
  `CREATE TABLE approvals (
     task TEXT NOT NULL REFERENCES tasks (id), id TEXT NOT NULL, step INTEGER, tool TEXT NOT NULL, description TEXT NOT NULL,
     requested_at TEXT NOT NULL, api_decision TEXT, api_always INTEGER, api_at TEXT,
     decision TEXT, always INTEGER, decided_by TEXT, decided_at TEXT, PRIMARY KEY (task, id));`,
  // The usage ledger: a row per ended task, for quotas and billing, which sum it by tenant and UTC day
  // rather than read every task. Tasks that ended before it have none.
  `CREATE TABLE usage (
     task TEXT PRIMARY KEY REFERENCES tasks (id), tenant TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL, seconds REAL NOT NULL);
   CREATE INDEX usage_by_tenant ON usage (tenant, day);
   CREATE INDEX tasks_by_created ON tasks (tenant, created);`,
  // The replicas up, each until its heartbeat runs out, which the metrics count.
  `CREATE TABLE replicas (id TEXT PRIMARY KEY, seen_until TEXT NOT NULL);`,
  // Every tenant's usage over a range of days (the admin's report) reads the ledger by day alone.
  `CREATE INDEX usage_by_day ON usage (day);`,
  // A tenant's tasks, newest first (the list without a status), are read in this index's order: it holds
  // each task's rowid after its tenant, as Postgres's tasks_by_tenant holds n. Without it, each page sorted
  // all of the tenant's tasks.
  `CREATE INDEX tasks_by_tenant_n ON tasks (tenant);`,
  // The last text a run wrote, kept on its task: its events may be dropped past the caps, or be many pages.
  `ALTER TABLE tasks ADD COLUMN result TEXT;
   ALTER TABLE tasks ADD COLUMN result_truncated INTEGER NOT NULL DEFAULT 0;`,
  // The Idempotency-Keys of creates, each with its body's hash and the task it made. A table of its own, so
  // adding it locks and scans nothing of tasks. No foreign key to tasks: a key's row may outlive its task
  // or go before it, and a key whose task is gone is as one never used.
  `CREATE TABLE idempotency (tenant TEXT NOT NULL, key TEXT NOT NULL, hash TEXT NOT NULL, task TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY (tenant, key));
   CREATE INDEX idempotency_by_created ON idempotency (created);`,
  // When a task's content was deleted (Store.purge). The index holds only the ended tasks that still have
  // theirs, in the order they ended, so retention's look for the next ones doesn't read the purged.
  `ALTER TABLE tasks ADD COLUMN purged TEXT;
   CREATE INDEX tasks_unpurged ON tasks (ended) WHERE purged IS NULL AND ended IS NOT NULL;`,
];

type Row = Record<string, unknown>;

/**
 * Whether a store's error is SQLite's SQLITE_FULL (13, whatever its extended code): the database's disk had
 * no room for a write. Only that: a quota, a -shm file that can't grow and a journal that can't be made are
 * other codes, and are retried like any failure. Postgres's 53100 isn't one either: its disk is its server's.
 */
export function diskFull(err: unknown): boolean {
  const { code, errcode } = (err ?? {}) as { code?: unknown; errcode?: unknown };
  return code === "ERR_SQLITE_ERROR" && typeof errcode === "number" && (errcode & 0xff) === 13;
}

/** A task's columns but its prompt and its result, which a list leaves out. */
export const TASK_COLUMNS = "id, tenant, spec, status, exit_code, stop, error, created, started, ended, stats, usage, cost, result_truncated, purged";
/** The two it leaves out, or what stands in their place, for a list's SELECT. */
export const longColumns = (prompts: boolean): string => (prompts ? "prompt, result" : "'' AS prompt, NULL AS result");

/**
 * What is left of a purged task's spec: its limits, its model and how it asked, which the API's views show.
 * The workspace (its files, or its repository's URL, which may hold a token) goes, as the prompt does.
 * Computed here, from the spec as it was read, and written back whole: SQL's JSON operators refuse a stored
 * "\u0000" on Postgres.
 */
export function slimSpec(spec: Partial<TaskSpec>): Pick<TaskSpec, "maxSteps" | "timeLimit" | "model" | "approvals" | "mode"> {
  const { maxSteps, timeLimit, model, approvals, mode } = spec;
  return { maxSteps: maxSteps!, timeLimit: timeLimit!, model: model!, ...(approvals !== undefined && { approvals }), ...(mode !== undefined && { mode }) };
}

/**
 * SQLite's pick of the tasks retention purges next: `?` is the time they ended before, then how many. It
 * says the tasks_unpurged index's own condition, word for word, or SQLite wouldn't use the index.
 */
export const UNPURGED = "SELECT id, spec FROM tasks WHERE purged IS NULL AND ended IS NOT NULL AND ended < ? ORDER BY ended LIMIT ?";

/** What a tenant has used of each cap, as admit counts it and standing reports it: the tenant, then the period's bounds. */
const USED: Record<Cap, string> = {
  maxQueued: "SELECT count(*) FROM tasks WHERE tenant = ? AND status = 'queued'",
  tasksPerDay: "SELECT count(*) FROM tasks WHERE tenant = ? AND created >= ? AND created < ?",
  usdPerDay: "SELECT coalesce(sum(cost_usd), 0) FROM usage WHERE tenant = ? AND day = ?",
  usdPerMonth: "SELECT coalesce(sum(cost_usd), 0) FROM usage WHERE tenant = ? AND day >= ? AND day < ?",
};
const RUNNING = "SELECT count(*) FROM tasks WHERE tenant = ? AND status = 'running'";

// One replica's store, or several processes' on one machine: SQLite has no notifications, so changes
// made by another process are found by looking again, and claims take its write lock.
class SqliteStore implements Store {
  private db: DatabaseSync;
  // Each stream and each wait for an approval's answer listens.
  readonly changes: Changes = new EventEmitter().setMaxListeners(0);
  readonly live = false;
  private region?: string;

  constructor(path: string, region?: string) {
    this.region = region;
    try {
      // A fresh checkout has no folder for the file yet.
      if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
      // Loaded here rather than imported, so a service on Postgres doesn't print Node's warning that
      // SQLite is experimental.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      this.db = new DatabaseSync(path);
    } catch (err) {
      throw new Error(`Couldn't open the database ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // WAL lets readers go on while a run's events are written; the timeout rides out another process's write.
    // secure_delete overwrites what a delete or a shorter value frees with zeros, so a purged task's prompt
    // and events aren't left readable in the file's free pages. It costs where much is deleted: measured,
    // a task's 64 MiB of events go in about 0.3 s rather than 0.02, and the WAL grows by as much meanwhile.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");
    const read = () => Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    const version = read();
    if (version > MIGRATIONS.length) throw new Error(`${path} was made by a newer version of the task service (schema ${version})`);
    for (let next = version; next < MIGRATIONS.length; next++) {
      // The write lock first, then the version again: another process opening the file may have run this one.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (read() > next) {
          this.db.exec("COMMIT");
          continue;
        }
        this.db.exec(MIGRATIONS[next]);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.rollback();
        throw err;
      }
    }
  }

  async putTenant(tenant: Tenant, keyHashes: string[]): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO tenants (id, limits) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET limits = excluded.limits").run(tenant.id, JSON.stringify(tenant.limits));
      this.db.prepare("DELETE FROM api_keys WHERE tenant = ?").run(tenant.id);
      for (const hash of keyHashes) this.db.prepare("INSERT OR REPLACE INTO api_keys (hash, tenant) VALUES (?, ?)").run(hash, tenant.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  async tenant(id: string): Promise<Tenant | undefined> {
    const row = this.db.prepare("SELECT id, limits FROM tenants WHERE id = ?").get(id) as Row | undefined;
    return row && { id: String(row.id), limits: JSON.parse(String(row.limits)) };
  }

  async tenantByKey(keyHash: string): Promise<Tenant | undefined> {
    const row = this.db.prepare("SELECT tenant FROM api_keys WHERE hash = ?").get(keyHash) as Row | undefined;
    return row && this.tenant(String(row.tenant));
  }

  async retireTenants(keep: string[]): Promise<number> {
    const kept = JSON.stringify(keep);
    return this.atomically(() => {
      this.db.prepare("DELETE FROM api_keys WHERE tenant NOT IN (SELECT value FROM json_each(?))").run(kept);
      const ended = this.db
        .prepare(`UPDATE tasks SET status = 'cancelled', ended = ?, error = 'its tenant was removed from the config' WHERE status = 'queued' AND tenant NOT IN (SELECT value FROM json_each(?)) RETURNING ${ENDED}`)
        .all(new Date().toISOString(), kept) as Row[];
      this.ledger(ended);
      return ended.length;
    });
  }

  createTask(tenant: string, spec: TaskSpec): Promise<Task>;
  createTask(tenant: string, spec: TaskSpec, caps: Caps, idem?: Idempotency): Promise<Task | Refusal | Replay>;
  async createTask(tenant: string, spec: TaskSpec, caps?: Caps, idem?: Idempotency): Promise<Task | Refusal | Replay> {
    return caps ? this.admit(tenant, spec, caps, idem) : this.insert(tenant, spec, new Date());
  }

  /** Adds the task, created at `created`: its id. */
  private add(tenant: string, spec: TaskSpec, created: Date): string {
    const id = newTaskId(this.region);
    const { prompt, ...rest } = spec;
    this.db.prepare("INSERT INTO tasks (id, tenant, prompt, spec, status, created) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, tenant, prompt, JSON.stringify(rest), created.toISOString());
    return id;
  }

  private async insert(tenant: string, spec: TaskSpec, created: Date): Promise<Task> {
    return (await this.task(this.add(tenant, spec, created)))!;
  }

  /**
   * createTask with its caps, under SQLite's write lock, which other processes wait for. Nothing here
   * waits, so no other statement of this process's runs inside it. The task is created at the caps' `now`,
   * the clock the quotas' days are read from, so it is counted on the day they say.
   *
   * atomically commits when its body returns, so every statement here is synchronous and comes before
   * the first await: the key's lookup, the removal of one that ran out, the caps, the task's insert and the
   * key's. The task is read back (this.task, which reads before it first waits) as the body's last step.
   */
  private admit(tenant: string, spec: TaskSpec, caps: Caps, idem?: Idempotency): Promise<Task | Refusal | Replay> {
    return this.atomically(() => {
      if (idem) {
        const row = this.db.prepare(IDEMPOTENT).get(tenant, idem.key) as Row | undefined;
        // Before the caps: a retry of a create that was made isn't a new task for the queue or the quotas.
        if (row && row.id !== null && !expired(String(row.idem_created), caps.now)) return Promise.resolve({ replay: toTask(row), same: row.idem_hash === idem.hash });
        // Run out, or its task is gone: the key is free again.
        if (row) this.db.prepare("DELETE FROM idempotency WHERE tenant = ? AND key = ?").run(tenant, idem.key);
      }
      const { day, dayStart, nextDay, monthStart, nextMonth } = periods(caps.now);
      const one = (sql: string, ...params: string[]) => Number(Object.values(this.db.prepare(sql).get(tenant, ...params) as Row)[0]);
      const refused = refusal(caps, (cap) =>
        cap === "maxQueued" ? one(USED.maxQueued)
        : cap === "tasksPerDay" ? one(USED.tasksPerDay, dayStart.toISOString(), nextDay.toISOString())
        : cap === "usdPerDay" ? one(USED.usdPerDay, day)
        : one(USED.usdPerMonth, isoDay(monthStart), isoDay(nextMonth)),
      );
      if (refused) return Promise.resolve(refused);
      const id = this.add(tenant, spec, caps.now);
      // Not an upsert: a key already there would be a fault in the above, and fails the create, task and all.
      if (idem) this.db.prepare("INSERT INTO idempotency (tenant, key, hash, task, created) VALUES (?, ?, ?, ?, ?)").run(tenant, idem.key, idem.hash, id, caps.now.toISOString());
      return this.task(id) as Promise<Task>;
    }, "BEGIN IMMEDIATE");
  }

  async task(id: string): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row && toTask(row);
  }

  /** No statement here waits for another, so the five counts are of one moment. */
  async standing(tenant: string, now: Date): Promise<Standing> {
    const { day, dayStart, nextDay, monthStart, nextMonth } = periods(now);
    const one = (sql: string, ...params: string[]) => Number(Object.values(this.db.prepare(sql).get(tenant, ...params) as Row)[0]);
    return {
      queued: one(USED.maxQueued),
      running: one(RUNNING),
      tasksToday: one(USED.tasksPerDay, dayStart.toISOString(), nextDay.toISOString()),
      usdToday: one(USED.usdPerDay, day),
      usdThisMonth: one(USED.usdPerMonth, isoDay(monthStart), isoDay(nextMonth)),
    };
  }

  async tasks(tenant: string, { status = [], limit = 100, before, prompts = false }: TasksQuery = {}): Promise<Task[]> {
    const one = (status: TaskStatus | undefined, columns: string) => {
      const where = ["tenant = ?", ...(status ? ["status = ?"] : []), ...(before ? ["rowid < (SELECT rowid FROM tasks WHERE id = ? AND tenant = ?)"] : [])];
      return {
        sql: `SELECT ${TASK_COLUMNS}, ${longColumns(prompts)}${columns} FROM tasks WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`,
        params: [tenant, ...(status ? [status] : []), ...(before ? [before, tenant] : []), limit],
      };
    };
    if (status.length < 2) {
      const { sql, params } = one(status[0], "");
      return (this.db.prepare(sql).all(...params) as Row[]).map(toTask);
    }
    // Several statuses: each one's newest `limit`, read in its index's order as a single status is, then the
    // newest `limit` of those. status IN (...) would walk the tenant's whole history to sort it.
    const arms = status.map((status) => one(status, ", rowid AS r"));
    const sql = `${arms.map((arm) => `SELECT * FROM (${arm.sql})`).join(" UNION ALL ")} ORDER BY r DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...arms.flatMap((arm) => arm.params), limit) as Row[]).map(toTask);
  }

  async inStatus(status: TaskStatus): Promise<Task[]> {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY rowid").all(status) as Row[]).map(toTask);
  }

  // These go through the (tenant, status) index, so the scheduler's look at the queue costs the same with
  // ten tasks queued or a million, and reads no prompt but those of the tasks it starts.
  async queuedTenants(): Promise<string[]> {
    const rows = this.db.prepare("SELECT id FROM tenants WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.tenant = tenants.id AND status = 'queued') ORDER BY id").all() as Row[];
    return rows.map((row) => String(row.id));
  }

  async claim(tenant: string, { owner, leaseMs, concurrency, tenantConcurrency }: ClaimTerms): Promise<Task | "full" | "tenant full" | undefined> {
    // IMMEDIATE takes the write lock first, so another process can't count the same free slot meanwhile.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const counts = this.db.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE tenant = ?) AS mine FROM tasks WHERE status = 'running'").get(tenant) as Row;
      let result: Task | "full" | "tenant full" | undefined;
      if (Number(counts.total) >= concurrency) result = "full";
      else if (Number(counts.mine) >= tenantConcurrency) result = "tenant full";
      else {
        const now = Date.now();
        const row = this.db
          .prepare("UPDATE tasks SET status = 'running', started = ?, owner = ?, lease_until = ?, cancel_requested = 0 WHERE id = (SELECT id FROM tasks WHERE tenant = ? AND status = 'queued' ORDER BY rowid LIMIT 1) RETURNING *")
          .get(new Date(now).toISOString(), owner, new Date(now + leaseMs).toISOString(), tenant) as Row | undefined;
        result = row && toTask(row);
      }
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  async renew(ids: string[], owner: string, leaseMs: number): Promise<{ id: string; cancel: boolean }[]> {
    const rows = this.db
      .prepare("UPDATE tasks SET lease_until = ? WHERE id IN (SELECT value FROM json_each(?)) AND owner = ? AND status = 'running' RETURNING id, cancel_requested")
      .all(new Date(Date.now() + leaseMs).toISOString(), JSON.stringify(ids), owner) as Row[];
    return rows.map((row) => ({ id: String(row.id), cancel: Boolean(row.cancel_requested) }));
  }

  async expire(error: string, graceMs = 0): Promise<string[]> {
    const now = new Date();
    return this.atomically(() => {
      // A task left running by a version of the service without leases has none: it is as gone.
      const rows = this.db
        .prepare(`UPDATE tasks SET status = 'error', error = ?, ended = ? WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?) RETURNING ${ENDED}`)
        .all(error, now.toISOString(), new Date(now.getTime() - graceMs).toISOString()) as Row[];
      this.ledger(rows);
      return rows.map((row) => String(row.id));
    });
  }

  async requestCancel(id: string): Promise<boolean> {
    return this.db.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ? AND status = 'running'").run(id).changes === 1;
  }

  async cancelQueued(id: string): Promise<boolean> {
    return this.atomically(() => {
      const rows = this.db.prepare(`UPDATE tasks SET status = 'cancelled', ended = ? WHERE id = ? AND status = 'queued' RETURNING ${ENDED}`).all(new Date().toISOString(), id) as Row[];
      this.ledger(rows);
      return rows.length === 1;
    });
  }

  async finish(id: string, owner: string, outcome: Outcome): Promise<boolean> {
    return this.atomically(() => {
      const rows = this.db
        .prepare(`UPDATE tasks SET status = ?, exit_code = ?, stop = ?, error = ?, stats = ?, usage = ?, cost = ?, result = ?, result_truncated = ?, ended = ? WHERE id = ? AND status = 'running' AND owner = ? RETURNING ${ENDED}`)
        // node:sqlite binds neither undefined nor a boolean.
        .all(outcome.status, outcome.exitCode, outcome.stop, outcome.error, json(outcome.stats), json(outcome.usage), outcome.cost, outcome.result ?? null, outcome.resultTruncated ? 1 : 0, new Date().toISOString(), id, owner) as Row[];
      this.ledger(rows, spentOf(outcome));
      return rows.length === 1;
    });
  }

  /** The ledger's rows for tasks that just ended (their ENDED columns), each having spent `spent`. */
  private ledger(rows: Row[], spent: Spent = NOTHING): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO usage (task, tenant, day, model, status, input, output, cache_read, cache_write, cost_usd, seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      const ended = String(row.ended);
      const seconds = row.started === null ? 0 : (Date.parse(ended) - Date.parse(String(row.started))) / 1000;
      const model = String((JSON.parse(String(row.spec)) as Partial<TaskSpec>).model ?? "");
      insert.run(String(row.id), String(row.tenant), ended.slice(0, 10), model, String(row.status), spent.input, spent.output, spent.cacheRead, spent.cacheWrite, spent.costUsd, seconds);
    }
  }

  async usage(query: UsageQuery): Promise<UsageRow[]> {
    const keys = usageKeys(query);
    const where = ["day >= ?", "day <= ?", ...(query.tenant !== undefined ? ["tenant = ?"] : [])];
    const sql = `SELECT ${[...keys, USAGE_SUMS].join(", ")} FROM usage WHERE ${where.join(" AND ")}${keys.length ? ` GROUP BY ${keys.join(", ")}` : ""}`;
    return usageRows(this.db.prepare(sql).all(query.from, query.to, ...(query.tenant !== undefined ? [query.tenant] : [])) as Row[], keys);
  }

  async heartbeat(replica: string, ms: number): Promise<void> {
    const now = Date.now();
    this.db.prepare("INSERT INTO replicas (id, seen_until) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET seen_until = excluded.seen_until").run(replica, new Date(now + ms).toISOString());
    this.db.prepare("DELETE FROM replicas WHERE seen_until < ?").run(new Date(now).toISOString());
  }

  async leave(replica: string): Promise<void> {
    this.db.prepare("DELETE FROM replicas WHERE id = ?").run(replica);
  }

  async counts(): Promise<Counts> {
    const tasks = this.db.prepare(COUNT_TASKS).all() as Row[];
    const pending = this.db.prepare(COUNT_PENDING).get() as Row;
    const replicas = this.db.prepare("SELECT count(*) AS n FROM replicas WHERE seen_until >= ?").get(new Date().toISOString()) as Row;
    return countsOf(tasks, Number(pending.n), Number(replicas.n));
  }

  /**
   * Rolls back the transaction a failed write left open, if it left one. On a full disk SQLite has already
   * rolled back when COMMIT fails, and a second ROLLBACK throws "no transaction is active" in place of the
   * real error.
   */
  private rollback(): void {
    if (this.db.isTransaction) this.db.exec("ROLLBACK");
  }

  /** Runs `body` in a transaction: committed if it returns, rolled back if it throws. It must not wait. */
  private atomically<T>(body: () => T, begin = "BEGIN"): T {
    this.db.exec(begin);
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  async purge(id: string): Promise<{ task: Task; first: boolean } | undefined> {
    return this.atomically(() => {
      const row = this.db.prepare("SELECT id, spec, ended, purged FROM tasks WHERE id = ?").get(id) as Row | undefined;
      if (!row) return undefined;
      if (row.ended !== null) this.blank([row]);
      return { task: toTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row), first: row.ended !== null && row.purged === null };
    }, "BEGIN IMMEDIATE");
  }

  async purgeEnded(olderThanMs: number, limit: number): Promise<number> {
    return this.atomically(() => {
      const rows = this.db.prepare(UNPURGED).all(new Date(Date.now() - olderThanMs).toISOString(), limit) as Row[];
      this.blank(rows);
      return rows.length;
    }, "BEGIN IMMEDIATE");
  }

  async forgetKeys(now: Date): Promise<number> {
    return Number(this.db.prepare("DELETE FROM idempotency WHERE created <= ?").run(new Date(now.getTime() - IDEMPOTENCY_MS).toISOString()).changes);
  }

  /** Deletes the content of ended tasks (their id and spec columns), inside a transaction: see Store.purge. */
  private blank(rows: Row[]): void {
    const now = new Date().toISOString();
    const update = this.db.prepare("UPDATE tasks SET prompt = '', spec = ?, error = NULL, stats = NULL, result = NULL, result_truncated = 0, purged = coalesce(purged, ?) WHERE id = ?");
    const events = this.db.prepare("DELETE FROM events WHERE task = ?");
    const approvals = this.db.prepare("DELETE FROM approvals WHERE task = ?");
    for (const row of rows) {
      const id = String(row.id);
      update.run(JSON.stringify(slimSpec(JSON.parse(String(row.spec)) as Partial<TaskSpec>)), now, id);
      events.run(id);
      approvals.run(id);
    }
  }

  // Nothing is stored for a purged task, or for one the store doesn't have: a run's late event, say, from a
  // replica that hadn't heard. Silently, as for a seq already kept.
  async addEvent(task: string, seq: number, event: object): Promise<void> {
    this.db.prepare(`INSERT OR IGNORE INTO events (task, seq, json) SELECT ?1, ?2, ?3 WHERE ${LIVE}`).run(task, seq, JSON.stringify(event));
  }

  async events(task: string, after = 0, limit?: number, bytes = Infinity): Promise<{ seq: number; event: object }[]> {
    const events: { seq: number; event: object }[] = [];
    let read = 0;
    // SQLite takes a negative limit as none. Leaving the loop early stops the statement.
    for (const row of this.db.prepare("SELECT seq, json FROM events WHERE task = ? AND seq > ? ORDER BY seq LIMIT ?").iterate(task, after, limit ?? -1) as Iterable<Row>) {
      if (read >= bytes) break;
      const json = String(row.json);
      read += Buffer.byteLength(json);
      events.push({ seq: Number(row.seq), event: JSON.parse(json) });
    }
    return events;
  }

  async addApproval(task: string, { id, step, tool, description }: ApprovalRequest): Promise<Approval | undefined> {
    const row = this.db
      .prepare(`INSERT INTO approvals (task, id, step, tool, description, requested_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${LIVE} ON CONFLICT DO NOTHING RETURNING *`)
      .get(task, id, step, tool, description, new Date().toISOString()) as Row | undefined;
    return row && toApproval(row);
  }

  async approval(task: string, id: string): Promise<Approval | undefined> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE task = ? AND id = ?").get(task, id) as Row | undefined;
    return row && toApproval(row);
  }

  async approvals(task: string): Promise<Approval[]> {
    return (this.db.prepare("SELECT * FROM approvals WHERE task = ? ORDER BY rowid").all(task) as Row[]).map(toApproval);
  }

  async decideApproval(task: string, id: string, { decision, always, by }: Answer): Promise<Approval | undefined> {
    const row = this.db
      .prepare(
        "UPDATE approvals SET api_decision = ?1, api_always = ?2, api_at = ?4, decision = ?1, always = ?2, decided_by = ?3, decided_at = ?4 WHERE task = ?5 AND id = ?6 AND decision IS NULL RETURNING *",
      )
      .get(decision, Number(always), by, new Date().toISOString(), task, id) as Row | undefined;
    return row && toApproval(row);
  }

  async recordApproval(task: string, id: string, { decision, always, by }: Answer): Promise<boolean> {
    // A timeout is decided now. An answer by the API is kept only as the API gave it (always may be
    // dropped, as jig drops it from a deny), and with the time it was given.
    const { changes } =
      by === "timeout"
        ? this.db.prepare("UPDATE approvals SET decision = 'deny', always = 0, decided_by = 'timeout', decided_at = ? WHERE task = ? AND id = ?").run(new Date().toISOString(), task, id)
        : this.db
            .prepare("UPDATE approvals SET decision = ?1, always = ?2, decided_by = 'api', decided_at = api_at WHERE task = ?3 AND id = ?4 AND api_decision = ?1 AND (?2 = 0 OR api_always = 1)")
            .run(decision, Number(always), task, id);
    return Number(changes) > 0;
  }

  async given(task: string, id: string): Promise<Given | undefined> {
    return toGiven(this.db.prepare("SELECT api_decision, api_always, decided_by FROM approvals WHERE task = ? AND id = ?").get(task, id) as Row | undefined);
  }

  async pendingApprovals(tasks: string[]): Promise<Map<string, number>> {
    const rows = this.db.prepare("SELECT task, count(*) AS n FROM approvals WHERE task IN (SELECT value FROM json_each(?)) AND decision IS NULL GROUP BY task").all(JSON.stringify(tasks)) as Row[];
    return new Map(rows.map((row) => [String(row.task), Number(row.n)]));
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1").get();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * A tenant's key (its two parameters, in either store's placeholders) with the task it made: the key's hash
 * and time beside the task's columns, which are null if the task is gone.
 */
export const idempotent = (tenant: string, key: string) =>
  `SELECT i.hash AS idem_hash, i.created AS idem_created, t.* FROM idempotency i LEFT JOIN tasks t ON t.id = i.task WHERE i.tenant = ${tenant} AND i.key = ${key}`;
const IDEMPOTENT = idempotent("?", "?");

/** Whether the task an event or an approval is for (?1) still keeps them, in SQLite's inserts. */
const LIVE = "EXISTS (SELECT 1 FROM tasks WHERE id = ?1 AND purged IS NULL)";

// What the metrics count, in SQL either store runs: through the status index, and the approvals of running
// tasks only, as those of a task that ended are never answered.
export const COUNT_TASKS = "SELECT tenant, status, count(*) AS n, min(created) AS oldest FROM tasks WHERE status IN ('queued', 'running') GROUP BY tenant, status";
export const COUNT_PENDING = "SELECT count(*) AS n FROM approvals JOIN tasks ON tasks.id = approvals.task WHERE tasks.status = 'running' AND approvals.decision IS NULL";

/** The counts from either store's rows. */
export function countsOf(tasks: Row[], pendingApprovals: number, replicas: number): Counts {
  const counted = tasks.map((row) => ({ tenant: String(row.tenant), status: row.status as "queued" | "running", count: Number(row.n), oldest: time(row.oldest)! }));
  return { tasks: counted, pendingApprovals, replicas };
}

/** The columns of a task that just ended that its row of the ledger needs. */
export const ENDED = "id, tenant, spec, status, started, ended";

/** What a task spent, as the ledger keeps it. */
export interface Spent {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

const NOTHING: Spent = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

/**
 * What a run's outcome says it spent, from its end event. On Docker and Kubernetes a task's commands can
 * write that event, so anything but a count or a cost (a negative, a string, a fraction) is taken as 0
 * rather than let fail the statement that ends the task.
 */
export function spentOf(outcome: Outcome): Spent {
  const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
  const usage = (outcome.usage ?? {}) as Partial<Record<keyof Usage, unknown>>;
  const cost = outcome.cost;
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0,
  };
}

/** A time's UTC day, YYYY-MM-DD. */
export function isoDay(time: Date): string {
  return time.toISOString().slice(0, 10);
}

/** The UTC day and month `now` is in: the day's name, and when each starts and the next starts. */
export function periods(now: Date): { day: string; dayStart: Date; nextDay: Date; monthStart: Date; nextMonth: Date } {
  const [year, month, date] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  return { day: isoDay(now), dayStart: new Date(Date.UTC(year, month, date)), nextDay: new Date(Date.UTC(year, month, date + 1)), monthStart: new Date(Date.UTC(year, month, 1)), nextMonth: new Date(Date.UTC(year, month + 1, 1)) };
}

/** USD to the nanodollar: sums of costs like 0.1 + 0.2 don't come out a hair under a limit, or show as 0.30000000000000004. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1e9) / 1e9;
}

/** The first cap the tenant is at, by `used`, which measures only the caps that are set. */
export function refusal(caps: Caps, used: (cap: Cap) => number): Refusal | undefined {
  for (const quota of CAPS) {
    const limit = caps[quota];
    if (limit === undefined) continue;
    const spent = quota.startsWith("usd") ? roundUsd(used(quota)) : used(quota);
    if (spent >= limit) return { quota, limit, used: spent };
  }
  return undefined;
}

/** The sums of a usage report's rows, in SQL either store runs. */
export const USAGE_SUMS =
  "count(*) AS tasks, sum(input) AS input, sum(output) AS output, sum(cache_read) AS cache_read, sum(cache_write) AS cache_write, sum(cost_usd) AS cost_usd, sum(seconds) AS seconds";

/** The columns a usage report groups by: the tenant if asked, then its groups (only these names reach SQL). */
export function usageKeys({ group, byTenant }: UsageQuery): ("tenant" | "day" | "model")[] {
  return [...(byTenant ? (["tenant"] as const) : []), ...group.filter((key) => key === "day" || key === "model")];
}

/** A usage report's rows from either store's, sorted by their keys (as bytes, the same in both). */
export function usageRows(rows: Row[], keys: ("tenant" | "day" | "model")[]): UsageRow[] {
  const sorted = rows.map((row) => ({
    ...Object.fromEntries(keys.map((key) => [key, String(row[key])])),
    tasks: Number(row.tasks),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    costUsd: roundUsd(Number(row.cost_usd)),
    seconds: Math.round(Number(row.seconds) * 1000) / 1000,
  }));
  const order = (a: UsageRow, b: UsageRow) => {
    for (const key of keys) if (a[key] !== b[key]) return a[key]! < b[key]! ? -1 : 1;
    return 0;
  };
  return sorted.sort(order);
}

/** task_<32 hex digits>, or task_<region>_<32 hex digits>, which says where the task lives (router.ts). */
export function newTaskId(region?: string): string {
  return `task_${region ? `${region}_` : ""}${randomUUID().replaceAll("-", "")}`;
}

/** A value for a JSON column, as text. */
export function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** A JSON column's value: text from SQLite, already decoded from Postgres. */
function parsed(value: unknown): unknown {
  return value === null || value === undefined ? null : typeof value === "string" ? JSON.parse(value) : value;
}

/** A time column's value as an ISO string: SQLite keeps them so, Postgres gives Dates. */
function time(value: unknown): string | null {
  return value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
}

/** An approval from its row, in either store, with only the fields it has. */
export function toApproval(row: Row): Approval {
  return {
    id: String(row.id),
    step: row.step === null ? null : Number(row.step),
    tool: String(row.tool),
    description: String(row.description),
    requestedAt: time(row.requested_at)!,
    ...(row.decision !== null && {
      decision: row.decision as Decision,
      always: Boolean(row.always),
      by: row.decided_by as Answer["by"],
      decidedAt: time(row.decided_at)!,
    }),
  };
}

/** The answer jig is given, from an approval's row in either store (see Store.given). */
export function toGiven(row: Row | undefined): Given | undefined {
  if (!row) return undefined;
  if (row.api_decision !== null) return { decision: row.api_decision as Decision, always: Boolean(row.api_always) };
  // jig's timeout stands for a deny, whatever its event said.
  if (row.decided_by === "timeout") return { decision: "deny", always: false };
  return undefined;
}

/** A task from its row, in either store. */
export function toTask(row: Row): Task {
  return {
    id: String(row.id),
    tenant: String(row.tenant),
    spec: { prompt: String(row.prompt), ...(parsed(row.spec) as Omit<TaskSpec, "prompt">) },
    status: row.status as TaskStatus,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    stop: row.stop as string | null,
    error: row.error as string | null,
    created: time(row.created)!,
    started: time(row.started),
    ended: time(row.ended),
    stats: parsed(row.stats),
    usage: parsed(row.usage) as Usage | null,
    cost: row.cost === null ? null : Number(row.cost),
    result: (row.result as string | null | undefined) ?? null,
    // A list that leaves the result out says nothing of its cut either.
    resultTruncated: row.result != null && Boolean(row.result_truncated),
    purged: time(row.purged),
  };
}
