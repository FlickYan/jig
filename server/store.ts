import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// The task service's state: tenants and their API keys, tasks, and each task's events. The interface is
// small and async so that a Postgres store can replace this one; this one is SQLite, through node:sqlite.

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

export interface TaskSpec {
  prompt: string;
  workspace?: Workspace;
  maxSteps: number;
  timeLimit: number;
  model: string;
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

export interface Store {
  /** Adds the tenant, or updates its limits; its API keys (SHA-256 hashes, in hex) become these. */
  putTenant(tenant: Tenant, keyHashes: string[]): Promise<void>;
  tenant(id: string): Promise<Tenant | undefined>;
  tenantByKey(keyHash: string): Promise<Tenant | undefined>;
  createTask(tenant: string, spec: TaskSpec): Promise<Task>;
  task(id: string): Promise<Task | undefined>;
  /** A tenant's tasks, newest first, at most `limit`. */
  tasks(tenant: string, options?: { status?: TaskStatus; limit?: number }): Promise<Task[]>;
  /** Every tenant's tasks in a status, oldest first: the queue, or what a crash left running. */
  inStatus(status: TaskStatus): Promise<Task[]>;
  /** Moves a queued task to running; false if it was no longer queued. */
  claim(id: string): Promise<boolean>;
  /** Moves a queued task to cancelled; false if it was no longer queued. */
  cancelQueued(id: string): Promise<boolean>;
  /** Ends a running task. */
  finish(id: string, outcome: Outcome): Promise<void>;
  /** Keeps one of a task's events; one with a seq already kept is ignored. */
  addEvent(task: string, seq: number, event: object): Promise<void>;
  /** A task's events after seq `after`, in order. */
  events(task: string, after?: number): Promise<{ seq: number; event: object }[]>;
  close(): Promise<void>;
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
];

type Row = Record<string, unknown>;

/** Opens (or creates) the SQLite store at `path` (":memory:" for one that lasts as long as the process). */
export function openStore(path: string): Store {
  return new SqliteStore(path);
}

class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
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

  async createTask(tenant: string, spec: TaskSpec): Promise<Task> {
    const id = `task_${randomUUID().replaceAll("-", "")}`;
    const { prompt, ...rest } = spec;
    this.db.prepare("INSERT INTO tasks (id, tenant, prompt, spec, status, created) VALUES (?, ?, ?, ?, 'queued', ?)").run(id, tenant, prompt, JSON.stringify(rest), new Date().toISOString());
    return (await this.task(id))!;
  }

  async task(id: string): Promise<Task | undefined> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row && toTask(row);
  }

  async tasks(tenant: string, { status, limit = 100 }: { status?: TaskStatus; limit?: number } = {}): Promise<Task[]> {
    const rows = status
      ? this.db.prepare("SELECT * FROM tasks WHERE tenant = ? AND status = ? ORDER BY rowid DESC LIMIT ?").all(tenant, status, limit)
      : this.db.prepare("SELECT * FROM tasks WHERE tenant = ? ORDER BY rowid DESC LIMIT ?").all(tenant, limit);
    return (rows as Row[]).map(toTask);
  }

  async inStatus(status: TaskStatus): Promise<Task[]> {
    return (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY rowid").all(status) as Row[]).map(toTask);
  }

  async claim(id: string): Promise<boolean> {
    const { changes } = this.db.prepare("UPDATE tasks SET status = 'running', started = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id);
    return changes === 1;
  }

  async cancelQueued(id: string): Promise<boolean> {
    const { changes } = this.db.prepare("UPDATE tasks SET status = 'cancelled', ended = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), id);
    return changes === 1;
  }

  async finish(id: string, outcome: Outcome): Promise<void> {
    this.db
      .prepare("UPDATE tasks SET status = ?, exit_code = ?, stop = ?, error = ?, stats = ?, usage = ?, cost = ?, ended = ? WHERE id = ? AND status = 'running'")
      .run(outcome.status, outcome.exitCode, outcome.stop, outcome.error, json(outcome.stats), json(outcome.usage), outcome.cost, new Date().toISOString(), id);
  }

  async addEvent(task: string, seq: number, event: object): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO events (task, seq, json) VALUES (?, ?, ?)").run(task, seq, JSON.stringify(event));
  }

  async events(task: string, after = 0): Promise<{ seq: number; event: object }[]> {
    const rows = this.db.prepare("SELECT seq, json FROM events WHERE task = ? AND seq > ? ORDER BY seq").all(task, after) as Row[];
    return rows.map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.json)) }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function parsed(value: unknown): unknown {
  return value === null || value === undefined ? null : JSON.parse(String(value));
}

function toTask(row: Row): Task {
  return {
    id: String(row.id),
    tenant: String(row.tenant),
    spec: { prompt: String(row.prompt), ...JSON.parse(String(row.spec)) },
    status: row.status as TaskStatus,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    stop: row.stop as string | null,
    error: row.error as string | null,
    created: String(row.created),
    started: row.started as string | null,
    ended: row.ended as string | null,
    stats: parsed(row.stats),
    usage: parsed(row.usage) as Usage | null,
    cost: row.cost === null ? null : Number(row.cost),
  };
}
