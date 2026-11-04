import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  task(id: string): Promise<Task | undefined>;
  /**
   * A tenant's tasks, newest first, at most `limit`, those older than the task `before` if it is given;
   * without their prompts (an empty string in their place) unless `prompts`.
   */
  tasks(tenant: string, options?: { status?: TaskStatus; limit?: number; before?: string; prompts?: boolean }): Promise<Task[]>;
  /** Every tenant's tasks in a status, oldest first. */
  inStatus(status: TaskStatus): Promise<Task[]>;
  /** The tenants with tasks queued, by id. */
  queuedTenants(): Promise<string[]>;
  /** How many of a tenant's tasks are queued. */
  queuedCount(tenant: string): Promise<number>;
  /**
   * Moves the tenant's oldest queued task to running, leased to `terms.owner`, unless as many tasks as
   * `terms.concurrency` run already ("full"), or as many of the tenant's as its own ("tenant full"); the
   * running ones are counted in the store, so replicas sharing it keep to the caps together. Undefined if
   * nothing of the tenant's is queued.
   */
  claim(tenant: string, terms: ClaimTerms): Promise<Task | "full" | "tenant full" | undefined>;
  /** Extends the owner's leases on these running tasks; those it still holds, and whether a cancel was asked for. */
  renew(ids: string[], owner: string, leaseMs: number): Promise<{ id: string; cancel: boolean }[]>;
  /** Ends, as errors, the running tasks whose lease ran out: their replica is gone. Their ids. */
  expire(error: string): Promise<string[]>;
  /** Asks the replica running the task to cancel it; false if it isn't running. */
  requestCancel(id: string): Promise<boolean>;
  /** Moves a queued task to cancelled; false if it was no longer queued. */
  cancelQueued(id: string): Promise<boolean>;
  /** Ends a running task, if the owner still holds it. */
  finish(id: string, owner: string, outcome: Outcome): Promise<void>;
  /** Keeps one of a task's events; one with a seq already kept is ignored. */
  addEvent(task: string, seq: number, event: object): Promise<void>;
  /** A task's events after seq `after`, in order. */
  events(task: string, after?: number): Promise<{ seq: number; event: object }[]>;
  /** Keeps an approval a task's jig asked for; undefined if the task has one with its id already. */
  addApproval(task: string, request: ApprovalRequest): Promise<Approval | undefined>;
  approval(task: string, id: string): Promise<Approval | undefined>;
  /** A task's approvals, in the order they were asked for. */
  approvals(task: string): Promise<Approval[]>;
  /** Answers an approval that has no answer yet: the approval, or undefined if there is no such one. */
  decideApproval(task: string, id: string, answer: Answer): Promise<Approval | undefined>;
  /** Keeps jig's own record of an approval's answer (its approval event), in place of any other. */
  recordApproval(task: string, id: string, answer: Answer): Promise<void>;
  /** How many of each task's approvals have no answer yet; a task with none is left out. */
  pendingApprovals(tasks: string[]): Promise<Map<string, number>>;
  /** What other replicas did, as it happens; a store that can't hear it never emits. */
  readonly changes: Changes;
  /** Whether changes are heard as they happen now: if not, whoever waits on them must look again itself. */
  readonly live: boolean;
  close(): Promise<void>;
}

/** Opens the store: Postgres for a postgres:// URL, else SQLite at the path (":memory:" for one in memory). */
export async function openStore(database: string): Promise<Store> {
  if (/^postgres(ql)?:\/\//.test(database)) return (await import("./store-pg.ts")).PostgresStore.open(database);
  return new SqliteStore(database);
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
  // The approvals a task's jig asked for, and their answers.
  `CREATE TABLE approvals (
     task TEXT NOT NULL REFERENCES tasks (id), id TEXT NOT NULL, step INTEGER, tool TEXT NOT NULL, description TEXT NOT NULL,
     requested_at TEXT NOT NULL, decision TEXT, always INTEGER, decided_by TEXT, decided_at TEXT, PRIMARY KEY (task, id));`,
];

type Row = Record<string, unknown>;

/** A task's columns but its prompt, which a list leaves out. */
export const TASK_COLUMNS = "id, tenant, spec, status, exit_code, stop, error, created, started, ended, stats, usage, cost";

// One replica's store, or several processes' on one machine: SQLite has no notifications, so changes
// made by another process are found by looking again, and claims take its write lock.
class SqliteStore implements Store {
  private db: DatabaseSync;
  // Each stream and each wait for an approval's answer listens.
  readonly changes: Changes = new EventEmitter().setMaxListeners(0);
  readonly live = false;

  constructor(path: string) {
    try {
      // A fresh checkout has no folder for the file yet.
      if (path !== ":memory:" && path !== "") mkdirSync(dirname(path), { recursive: true });
      this.db = new DatabaseSync(path);
    } catch (err) {
      throw new Error(`Couldn't open the database ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // WAL lets readers go on while a run's events are written; the timeout rides out another process's write.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version > MIGRATIONS.length) throw new Error(`${path} was made by a newer version of the task service (schema ${version})`);
    for (let next = version; next < MIGRATIONS.length; next++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[next]);
        this.db.exec(`PRAGMA user_version = ${next + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
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
      this.db.exec("ROLLBACK");
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
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM api_keys WHERE tenant NOT IN (SELECT value FROM json_each(?))").run(kept);
      const { changes } = this.db
        .prepare("UPDATE tasks SET status = 'cancelled', ended = ?, error = 'its tenant was removed from the config' WHERE status = 'queued' AND tenant NOT IN (SELECT value FROM json_each(?))")
        .run(new Date().toISOString(), kept);
      this.db.exec("COMMIT");
      return Number(changes);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async createTask(tenant: string, spec: TaskSpec): Promise<Task> {
    const id = newTaskId();
    const { prompt, ...rest } = spec;
    this.db.prepare("INSERT INTO tasks (id, tenant, prompt, spec, status, created) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, tenant, prompt, JSON.stringify(rest), new Date().toISOString());
    return (await this.task(id))!;
  }

  async task(id: string): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row && toTask(row);
  }

  async tasks(tenant: string, { status, limit = 100, before, prompts = false }: { status?: TaskStatus; limit?: number; before?: string; prompts?: boolean } = {}): Promise<Task[]> {
    const where = ["tenant = ?", ...(status ? ["status = ?"] : []), ...(before ? ["rowid < (SELECT rowid FROM tasks WHERE id = ? AND tenant = ?)"] : [])];
    const params = [tenant, ...(status ? [status] : []), ...(before ? [before, tenant] : []), limit];
    const rows = this.db.prepare(`SELECT ${TASK_COLUMNS}, ${prompts ? "prompt" : "'' AS prompt"} FROM tasks WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`).all(...params);
    return (rows as Row[]).map(toTask);
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

  async queuedCount(tenant: string): Promise<number> {
    return Number((this.db.prepare("SELECT count(*) AS n FROM tasks WHERE tenant = ? AND status = 'queued'").get(tenant) as Row).n);
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
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async renew(ids: string[], owner: string, leaseMs: number): Promise<{ id: string; cancel: boolean }[]> {
    const rows = this.db
      .prepare("UPDATE tasks SET lease_until = ? WHERE id IN (SELECT value FROM json_each(?)) AND owner = ? AND status = 'running' RETURNING id, cancel_requested")
      .all(new Date(Date.now() + leaseMs).toISOString(), JSON.stringify(ids), owner) as Row[];
    return rows.map((row) => ({ id: String(row.id), cancel: Boolean(row.cancel_requested) }));
  }

  async expire(error: string): Promise<string[]> {
    const now = new Date().toISOString();
    // A task left running by a version of the service without leases has none: it is as gone.
    const rows = this.db.prepare("UPDATE tasks SET status = 'error', error = ?, ended = ? WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?) RETURNING id").all(error, now, now) as Row[];
    return rows.map((row) => String(row.id));
  }

  async requestCancel(id: string): Promise<boolean> {
    return this.db.prepare("UPDATE tasks SET cancel_requested = 1 WHERE id = ? AND status = 'running'").run(id).changes === 1;
  }

  async cancelQueued(id: string): Promise<boolean> {
    const { changes } = this.db.prepare("UPDATE tasks SET status = 'cancelled', ended = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id);
    return changes === 1;
  }

  async finish(id: string, owner: string, outcome: Outcome): Promise<void> {
    this.db
      .prepare("UPDATE tasks SET status = ?, exit_code = ?, stop = ?, error = ?, stats = ?, usage = ?, cost = ?, ended = ? WHERE id = ? AND status = 'running' AND owner = ?")
      .run(outcome.status, outcome.exitCode, outcome.stop, outcome.error, json(outcome.stats), json(outcome.usage), outcome.cost, new Date().toISOString(), id, owner);
  }

  async addEvent(task: string, seq: number, event: object): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO events (task, seq, json) VALUES (?, ?, ?)").run(task, seq, JSON.stringify(event));
  }

  async events(task: string, after = 0): Promise<{ seq: number; event: object }[]> {
    const rows = this.db.prepare("SELECT seq, json FROM events WHERE task = ? AND seq > ? ORDER BY seq").all(task, after) as Row[];
    return rows.map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.json)) }));
  }

  async addApproval(task: string, { id, step, tool, description }: ApprovalRequest): Promise<Approval | undefined> {
    const row = this.db
      .prepare("INSERT INTO approvals (task, id, step, tool, description, requested_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING *")
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
      .prepare("UPDATE approvals SET decision = ?, always = ?, decided_by = ?, decided_at = ? WHERE task = ? AND id = ? AND decision IS NULL RETURNING *")
      .get(decision, Number(always), by, new Date().toISOString(), task, id) as Row | undefined;
    return row && toApproval(row);
  }

  async recordApproval(task: string, id: string, { decision, always, by }: Answer): Promise<void> {
    // jig confirming the API's answer leaves the time it was given; a timeout is decided now.
    this.db
      .prepare("UPDATE approvals SET decision = ?, always = ?, decided_by = ?, decided_at = CASE WHEN decided_at IS NOT NULL AND ? = 'api' THEN decided_at ELSE ? END WHERE task = ? AND id = ?")
      .run(decision, Number(always), by, by, new Date().toISOString(), task, id);
  }

  async pendingApprovals(tasks: string[]): Promise<Map<string, number>> {
    const rows = this.db.prepare("SELECT task, count(*) AS n FROM approvals WHERE task IN (SELECT value FROM json_each(?)) AND decision IS NULL GROUP BY task").all(JSON.stringify(tasks)) as Row[];
    return new Map(rows.map((row) => [String(row.task), Number(row.n)]));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function newTaskId(): string {
  return `task_${randomUUID().replaceAll("-", "")}`;
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
  };
}
