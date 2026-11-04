import { EventEmitter } from "node:events";
import { type Client, type Listener, Pool, type Row } from "./pg.ts";
import {
  type Answer,
  type Approval,
  type ApprovalRequest,
  type Caps,
  type ClaimTerms,
  type Changes,
  ENDED,
  type Given,
  isoDay,
  json,
  newTaskId,
  type Outcome,
  periods,
  type Refusal,
  refusal,
  spentOf,
  type Store,
  TASK_COLUMNS,
  type Task,
  type TaskSpec,
  type TaskStatus,
  type Tenant,
  toApproval,
  toGiven,
  toTask,
  USAGE_SUMS,
  type UsageQuery,
  type UsageRow,
  usageKeys,
  usageRows,
} from "./store.ts";

// The task service's state in Postgres (pg.ts), which several replicas of the service share. Claims count
// the running tasks under a lock the database holds for the transaction, so two replicas can't both take
// the last slot. Every change another replica may wait on is announced with NOTIFY in the statement that
// makes it: an event stored or a task ended on jig_events, a cancel asked for on jig_cancel, an approval
// answered on jig_approvals.

const EVENTS = "jig_events";
const CANCELS = "jig_cancel";
const APPROVALS = "jig_approvals";
// pg_advisory_xact_lock's keys: claims, and migrations (so two replicas starting at once don't both run them).
const CLAIM_LOCK = 7_366_000_001;
const MIGRATE_LOCK = 7_366_000_002;
// With a tenant's hashtext, a lock of its own on its new tasks: two 32-bit keys, a key space apart from the above.
const CREATE_LOCK = 7366;

// Each entry moves the schema one version on (jig_schema counts them). Never edit one that has shipped:
// add another. JSON is kept as `json`, which holds the text as it came, or as text: jsonb would turn away
// a "\u0000" in a command's output.
const MIGRATIONS = [
  `CREATE TABLE tenants (id text PRIMARY KEY, limits json NOT NULL);
   CREATE TABLE api_keys (hash text PRIMARY KEY, tenant text NOT NULL REFERENCES tenants (id));
   CREATE TABLE tasks (
     n bigserial UNIQUE, id text PRIMARY KEY, tenant text NOT NULL REFERENCES tenants (id), prompt text NOT NULL, spec json NOT NULL,
     status text NOT NULL, exit_code integer, stop text, error text,
     created timestamptz NOT NULL, started timestamptz, ended timestamptz, stats json, usage json, cost double precision,
     owner text, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false);
   CREATE INDEX tasks_by_tenant ON tasks (tenant, n);
   CREATE INDEX tasks_queue ON tasks (tenant, status, n);
   CREATE INDEX tasks_by_status ON tasks (status);
   CREATE TABLE events (task text NOT NULL REFERENCES tasks (id), seq integer NOT NULL, json text NOT NULL, PRIMARY KEY (task, seq));`,
  // The approvals a task's jig asked for, and their answers: the API's (api_*), which only an answer
  // through the API sets and jig is given, and the record (decision to decided_at), which jig's own
  // approval event replaces.
  `CREATE TABLE approvals (
     n bigserial UNIQUE, task text NOT NULL REFERENCES tasks (id), id text NOT NULL, step integer, tool text NOT NULL, description text NOT NULL,
     requested_at timestamptz NOT NULL, api_decision text, api_always boolean, api_at timestamptz,
     decision text, always boolean, decided_by text, decided_at timestamptz, PRIMARY KEY (task, id));`,
  // The usage ledger: a row per ended task, for quotas and billing, which sum it by tenant and UTC day
  // rather than read every task. Tasks that ended before it have none.
  `CREATE TABLE usage (
     task text PRIMARY KEY REFERENCES tasks (id), tenant text NOT NULL, day text NOT NULL, model text NOT NULL, status text NOT NULL,
     input bigint NOT NULL, output bigint NOT NULL, cache_read bigint NOT NULL, cache_write bigint NOT NULL, cost_usd double precision NOT NULL, seconds double precision NOT NULL);
   CREATE INDEX usage_by_tenant ON usage (tenant, day);
   CREATE INDEX tasks_by_created ON tasks (tenant, created);`,
];

/** The statement's rows, each announced as a task that ended (its id and status columns). */
const NOTIFY_DONE = `SELECT id, pg_notify('${EVENTS}', json_build_object('task', id, 'done', status)::text) FROM done`;
const IDS = "SELECT json_array_elements_text($1::json)";

/**
 * A CTE that writes the ledger's rows for the tasks in `done` (RETURNING ENDED), in the statement that ends
 * them, so in its transaction; `spent` is the SQL of input, output, cache_read, cache_write and cost_usd.
 */
const ledger = (spent = "0, 0, 0, 0, 0") =>
  `ledger AS (INSERT INTO usage (task, tenant, day, model, status, input, output, cache_read, cache_write, cost_usd, seconds)
     SELECT id, tenant, to_char(ended AT TIME ZONE 'UTC', 'YYYY-MM-DD'), coalesce(spec->>'model', ''), status, ${spent}, coalesce(extract(epoch FROM ended - started), 0)
     FROM done ON CONFLICT DO NOTHING)`;

export class PostgresStore implements Store {
  readonly changes: Changes = new EventEmitter().setMaxListeners(0);
  private pool: Pool;
  private listener: Listener;

  private constructor(pool: Pool, listener: Listener) {
    this.pool = pool;
    this.listener = listener;
    listener.on("notification", (channel: string, payload: string) => {
      let message: { task?: unknown; seq?: unknown; done?: unknown; id?: unknown };
      try {
        message = JSON.parse(payload);
      } catch {
        return;
      }
      if (typeof message.task !== "string") return;
      if (channel === EVENTS && typeof message.seq === "number") this.changes.emit("event", message.task, message.seq);
      else if (channel === EVENTS && typeof message.done === "string") this.changes.emit("done", message.task, message.done);
      else if (channel === CANCELS) this.changes.emit("cancel", message.task);
      else if (channel === APPROVALS && typeof message.id === "string") this.changes.emit("approval", message.task, message.id);
    });
    // What was announced while it was away is missed: whoever waits looks again.
    listener.on("connected", () => this.changes.emit("resync"));
  }

  /** Connects, moves the schema on to this version's and starts listening. */
  static async open(url: string): Promise<PostgresStore> {
    let pool: Pool | undefined;
    try {
      pool = new Pool(url);
      await migrate(pool);
      const listener = pool.listen([EVENTS, CANCELS, APPROVALS]);
      await listener.ready;
      return new PostgresStore(pool, listener);
    } catch (err) {
      await pool?.close();
      // The URL's password stays out of the message.
      const shown = url.replace(/\/\/([^:@/]*):[^@/]*@/, "//$1:***@");
      throw new Error(`Couldn't open the database ${shown}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get live(): boolean {
    return this.listener.live;
  }

  async putTenant(tenant: Tenant, keyHashes: string[]): Promise<void> {
    await this.pool.transaction(async (db) => {
      await db.query("INSERT INTO tenants (id, limits) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET limits = excluded.limits", [tenant.id, json(tenant.limits)]);
      await db.query("DELETE FROM api_keys WHERE tenant = $1", [tenant.id]);
      await db.query(`INSERT INTO api_keys (hash, tenant) SELECT hash, $2 FROM (${IDS} AS hash) AS keys ON CONFLICT (hash) DO UPDATE SET tenant = excluded.tenant`, [json([...new Set(keyHashes)]), tenant.id]);
    });
  }

  async tenant(id: string): Promise<Tenant | undefined> {
    const [row] = (await this.pool.query("SELECT id, limits FROM tenants WHERE id = $1", [id])).rows;
    return row && { id: String(row.id), limits: row.limits as Tenant["limits"] };
  }

  async tenantByKey(keyHash: string): Promise<Tenant | undefined> {
    const [row] = (await this.pool.query("SELECT tenants.id, tenants.limits FROM api_keys JOIN tenants ON tenants.id = api_keys.tenant WHERE api_keys.hash = $1", [keyHash])).rows;
    return row && { id: String(row.id), limits: row.limits as Tenant["limits"] };
  }

  async retireTenants(keep: string[]): Promise<number> {
    return this.pool.transaction(async (db) => {
      await db.query(`DELETE FROM api_keys WHERE tenant NOT IN (${IDS})`, [json(keep)]);
      const { rows } = await db.query(
        `WITH done AS (UPDATE tasks SET status = 'cancelled', ended = now(), error = 'its tenant was removed from the config' WHERE status = 'queued' AND tenant NOT IN (${IDS}) RETURNING ${ENDED}), ${ledger()} ${NOTIFY_DONE}`,
        [json(keep)],
      );
      return rows.length;
    });
  }

  createTask(tenant: string, spec: TaskSpec): Promise<Task>;
  createTask(tenant: string, spec: TaskSpec, caps: Caps): Promise<Task | Refusal>;
  async createTask(tenant: string, spec: TaskSpec, caps?: Caps): Promise<Task | Refusal> {
    const { prompt, ...rest } = spec;
    const insert = async (db: Client) => {
      const { rows } = await db.query("INSERT INTO tasks (id, tenant, prompt, spec, status, created) VALUES ($1, $2, $3, $4, 'queued', now()) RETURNING *", [newTaskId(), tenant, prompt, json(rest)]);
      return toTask(rows[0]);
    };
    if (!caps) return insert(this.pool);
    return this.pool.transaction(async (db) => {
      // Held to the transaction's end, so the counts and the insert are one replica's at a time, for this
      // tenant; each count is a statement of its own, which sees what the last insert committed.
      await db.query(`SELECT pg_advisory_xact_lock(${CREATE_LOCK}, hashtext($1))`, [tenant]);
      const { day, dayStart, nextDay, monthStart, nextMonth } = periods(caps.now);
      const one = async (sql: string, ...params: unknown[]) => Number(Object.values((await db.query(sql, [tenant, ...params])).rows[0])[0]);
      const used = {
        maxQueued: caps.maxQueued === undefined ? 0 : await one("SELECT count(*) FROM tasks WHERE tenant = $1 AND status = 'queued'"),
        tasksPerDay: caps.tasksPerDay === undefined ? 0 : await one("SELECT count(*) FROM tasks WHERE tenant = $1 AND created >= $2 AND created < $3", dayStart, nextDay),
        usdPerDay: caps.usdPerDay === undefined ? 0 : await one("SELECT coalesce(sum(cost_usd), 0) FROM usage WHERE tenant = $1 AND day = $2", day),
        usdPerMonth: caps.usdPerMonth === undefined ? 0 : await one("SELECT coalesce(sum(cost_usd), 0) FROM usage WHERE tenant = $1 AND day >= $2 AND day < $3", isoDay(monthStart), isoDay(nextMonth)),
      };
      return refusal(caps, (cap) => used[cap]) ?? insert(db);
    });
  }

  async task(id: string): Promise<Task | undefined> {
    const [row] = (await this.pool.query("SELECT * FROM tasks WHERE id = $1", [id])).rows;
    return row && toTask(row);
  }

  async tasks(tenant: string, { status, limit = 100, before, prompts = false }: { status?: TaskStatus; limit?: number; before?: string; prompts?: boolean } = {}): Promise<Task[]> {
    const params: unknown[] = [tenant];
    const where = ["tenant = $1"];
    if (status) where.push(`status = $${params.push(status)}`);
    if (before) where.push(`n < (SELECT n FROM tasks WHERE id = $${params.push(before)} AND tenant = $1)`);
    const sql = `SELECT ${TASK_COLUMNS}, ${prompts ? "prompt" : "'' AS prompt"} FROM tasks WHERE ${where.join(" AND ")} ORDER BY n DESC LIMIT $${params.push(limit)}`;
    return (await this.pool.query(sql, params)).rows.map(toTask);
  }

  async inStatus(status: TaskStatus): Promise<Task[]> {
    return (await this.pool.query("SELECT * FROM tasks WHERE status = $1 ORDER BY n", [status])).rows.map(toTask);
  }

  async queuedTenants(): Promise<string[]> {
    const { rows } = await this.pool.query("SELECT id FROM tenants WHERE EXISTS (SELECT 1 FROM tasks WHERE tasks.tenant = tenants.id AND status = 'queued') ORDER BY id");
    return rows.map((row) => String(row.id));
  }

  async queuedCount(tenant: string): Promise<number> {
    return Number((await this.pool.query("SELECT count(*) AS n FROM tasks WHERE tenant = $1 AND status = 'queued'", [tenant])).rows[0].n);
  }

  async claim(tenant: string, { owner, leaseMs, concurrency, tenantConcurrency }: ClaimTerms): Promise<Task | "full" | "tenant full" | undefined> {
    return this.pool.transaction(async (db) => {
      // Held to the transaction's end: the count below and the claim are one replica's at a time. The
      // count is a statement of its own, so it sees what the claim before this one committed.
      await db.query(`SELECT pg_advisory_xact_lock(${CLAIM_LOCK})`);
      const [counts] = (await db.query("SELECT count(*) AS total, count(*) FILTER (WHERE tenant = $1) AS mine FROM tasks WHERE status = 'running'", [tenant])).rows;
      if (Number(counts.total) >= concurrency) return "full";
      if (Number(counts.mine) >= tenantConcurrency) return "tenant full";
      // SKIP LOCKED passes over a task a cancel is changing meanwhile, rather than waiting for it.
      const [row] = (
        await db.query(
          `UPDATE tasks SET status = 'running', started = now(), owner = $2, lease_until = now() + $3 * interval '1 millisecond', cancel_requested = false
           WHERE id = (SELECT id FROM tasks WHERE tenant = $1 AND status = 'queued' ORDER BY n LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          [tenant, owner, leaseMs],
        )
      ).rows;
      return row && toTask(row);
    });
  }

  async renew(ids: string[], owner: string, leaseMs: number): Promise<{ id: string; cancel: boolean }[]> {
    const { rows } = await this.pool.query(
      `UPDATE tasks SET lease_until = now() + $3 * interval '1 millisecond' WHERE id IN (${IDS}) AND owner = $2 AND status = 'running' RETURNING id, cancel_requested`,
      [json(ids), owner, leaseMs],
    );
    return rows.map((row: Row) => ({ id: String(row.id), cancel: row.cancel_requested === true }));
  }

  async expire(error: string): Promise<string[]> {
    // The database's clock, not the replicas', says when a lease ran out.
    const { rows } = await this.pool.query(
      `WITH done AS (UPDATE tasks SET status = 'error', error = $1, ended = now() WHERE status = 'running' AND (lease_until IS NULL OR lease_until < now()) RETURNING ${ENDED}), ${ledger()} ${NOTIFY_DONE}`,
      [error],
    );
    return rows.map((row) => String(row.id));
  }

  async requestCancel(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `WITH asked AS (UPDATE tasks SET cancel_requested = true WHERE id = $1 AND status = 'running' RETURNING id) SELECT pg_notify('${CANCELS}', json_build_object('task', id)::text) FROM asked`,
      [id],
    );
    return rows.length === 1;
  }

  async cancelQueued(id: string): Promise<boolean> {
    const { rows } = await this.pool.query(`WITH done AS (UPDATE tasks SET status = 'cancelled', ended = now() WHERE id = $1 AND status = 'queued' RETURNING ${ENDED}), ${ledger()} ${NOTIFY_DONE}`, [id]);
    return rows.length === 1;
  }

  async finish(id: string, owner: string, outcome: Outcome): Promise<void> {
    const { input, output, cacheRead, cacheWrite, costUsd } = spentOf(outcome);
    await this.pool.query(
      `WITH done AS (UPDATE tasks SET status = $3, exit_code = $4, stop = $5, error = $6, stats = $7, usage = $8, cost = $9, ended = now()
       WHERE id = $1 AND status = 'running' AND owner = $2 RETURNING ${ENDED}), ${ledger("$10::bigint, $11::bigint, $12::bigint, $13::bigint, $14::double precision")} ${NOTIFY_DONE}`,
      [id, owner, outcome.status, outcome.exitCode, outcome.stop, outcome.error, json(outcome.stats), json(outcome.usage), outcome.cost, input, output, cacheRead, cacheWrite, costUsd],
    );
  }

  async addEvent(task: string, seq: number, event: object): Promise<void> {
    await this.pool.query(
      `WITH added AS (INSERT INTO events (task, seq, json) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING task, seq)
       SELECT pg_notify('${EVENTS}', json_build_object('task', task, 'seq', seq)::text) FROM added`,
      [task, seq, JSON.stringify(event)],
    );
  }

  async events(task: string, after = 0): Promise<{ seq: number; event: object }[]> {
    const { rows } = await this.pool.query("SELECT seq, json FROM events WHERE task = $1 AND seq > $2 ORDER BY seq", [task, after]);
    return rows.map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.json)) }));
  }

  async addApproval(task: string, { id, step, tool, description }: ApprovalRequest): Promise<Approval | undefined> {
    const [row] = (
      await this.pool.query("INSERT INTO approvals (task, id, step, tool, description, requested_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT DO NOTHING RETURNING *", [task, id, step, tool, description])
    ).rows;
    return row && toApproval(row);
  }

  async approval(task: string, id: string): Promise<Approval | undefined> {
    const [row] = (await this.pool.query("SELECT * FROM approvals WHERE task = $1 AND id = $2", [task, id])).rows;
    return row && toApproval(row);
  }

  async approvals(task: string): Promise<Approval[]> {
    return (await this.pool.query("SELECT * FROM approvals WHERE task = $1 ORDER BY n", [task])).rows.map(toApproval);
  }

  async decideApproval(task: string, id: string, { decision, always, by }: Answer): Promise<Approval | undefined> {
    // Announced, so a replica whose jig is waiting for it hears it at once.
    const [row] = (
      await this.pool.query(
        `WITH decided AS (UPDATE approvals SET api_decision = $3, api_always = $4, api_at = now(), decision = $3, always = $4, decided_by = $5, decided_at = now()
           WHERE task = $1 AND id = $2 AND decision IS NULL RETURNING *)
         SELECT *, pg_notify('${APPROVALS}', json_build_object('task', task, 'id', id)::text) FROM decided`,
        [task, id, decision, always, by],
      )
    ).rows;
    return row && toApproval(row);
  }

  async recordApproval(task: string, id: string, { decision, always, by }: Answer): Promise<boolean> {
    // As in SQLite's: a timeout is decided now, an answer by the API kept only as the API gave it.
    const { rowCount } =
      by === "timeout"
        ? await this.pool.query("UPDATE approvals SET decision = 'deny', always = false, decided_by = 'timeout', decided_at = now() WHERE task = $1 AND id = $2", [task, id])
        : await this.pool.query(
            "UPDATE approvals SET decision = $3, always = $4, decided_by = 'api', decided_at = api_at WHERE task = $1 AND id = $2 AND api_decision = $3 AND (NOT $4 OR api_always)",
            [task, id, decision, always],
          );
    return rowCount > 0;
  }

  async given(task: string, id: string): Promise<Given | undefined> {
    return toGiven((await this.pool.query("SELECT api_decision, api_always, decided_by FROM approvals WHERE task = $1 AND id = $2", [task, id])).rows[0]);
  }

  async pendingApprovals(tasks: string[]): Promise<Map<string, number>> {
    const { rows } = await this.pool.query(`SELECT task, count(*) AS n FROM approvals WHERE task IN (${IDS}) AND decision IS NULL GROUP BY task`, [json(tasks)]);
    return new Map(rows.map((row) => [String(row.task), Number(row.n)]));
  }

  async usage(query: UsageQuery): Promise<UsageRow[]> {
    const keys = usageKeys(query);
    const params: unknown[] = [query.from, query.to];
    const where = ["day >= $1", "day <= $2", ...(query.tenant !== undefined ? [`tenant = $${params.push(query.tenant)}`] : [])];
    const sql = `SELECT ${[...keys, USAGE_SUMS].join(", ")} FROM usage WHERE ${where.join(" AND ")}${keys.length ? ` GROUP BY ${keys.join(", ")}` : ""}`;
    return usageRows((await this.pool.query(sql, params)).rows, keys);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

/** Moves the schema on, under a lock, so replicas starting together run each migration once. */
async function migrate(pool: Pool): Promise<void> {
  await pool.transaction(async (db) => {
    await db.query(`SELECT pg_advisory_xact_lock(${MIGRATE_LOCK})`);
    await db.query("CREATE TABLE IF NOT EXISTS jig_schema (version integer NOT NULL)");
    const [row] = (await db.query("SELECT version FROM jig_schema")).rows;
    const version = row ? Number(row.version) : 0;
    if (!row) await db.query("INSERT INTO jig_schema (version) VALUES (0)");
    if (version > MIGRATIONS.length) throw new Error(`it was made by a newer version of the task service (schema ${version})`);
    // Postgres changes its schema in a transaction like anything else: a migration that fails leaves none of it.
    for (const migration of MIGRATIONS.slice(version)) for (const statement of migration.split(";").filter((part) => part.trim())) await db.query(statement);
    await db.query("UPDATE jig_schema SET version = $1", [MIGRATIONS.length]);
  });
}
