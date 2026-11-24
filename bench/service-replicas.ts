// Whether replicas of the task service add up: bench/service-load.ts runs the service, its replicas and its
// clients in one process, so on one core, and can't say. Here each replica is a process of its own (this
// script again, forked, with the stand-in runner of service-load.ts: no jig, no container, no model), on one
// Postgres database, and the clients stay in this one, spread over the replicas. From the repository's root:
//   JIG_TEST_POSTGRES_URL=postgres://... node bench/service-replicas.ts
// REPLICAS ("1,2,3": a scenario each), TENANTS ("1,8": likewise; one tenant's creates are made one at a time,
// by design), TASKS (2000), CLIENTS (32), CONCURRENCY (192: the service's cap, over all the replicas together,
// whatever their number, so each scenario is the same load), EVENTS (20) and RUN_MS (200) change the load;
// POOL sets each replica's databasePool.max (10). STORE_TIMES=1 prints what each replica's calls of the store
// took, and PROFILE=<dir> has each replica write a CPU profile there (node --cpu-prof).
//
// Beside the rates it checks what replicas must keep together: every task succeeded and was started once, by
// one replica; each has its EVENTS events and one row in the usage ledger; the streams followed (one task in
// ten, through another replica than the one it was posted to) had each event once, in order, then done; and
// no more ran at once than the service's cap, nor more of a tenant's than its own, as the replicas' runners
// saw them, their starts and ends put on one clock (the machine's).

import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { Pool } from "../server/pg.ts";
import type { JigEvent, RunHandle, Runner } from "../server/runner.ts";
import type { Store } from "../server/store.ts";
import { dropPostgresDatabases, postgresDatabase } from "../test/postgres.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const list = (name: string, fallback: string) => (process.env[name] ?? fallback).split(",").map(Number);
const TASKS = env("TASKS", 2000);
const CLIENTS = env("CLIENTS", 32);
const CONCURRENCY = env("CONCURRENCY", 192);
const EVENTS = env("EVENTS", 20);
const RUN_MS = env("RUN_MS", 200);
const POOL = env("POOL", 10);
const SECRET = "the load test's secret";
const key = (tenant: number) => `load-key-${tenant}`;

/** What the parent tells a replica to start with, and what a replica tells it back, over IPC. */
interface Start {
  database: string;
  dataDir: string;
  replicaId: string;
  tenants: number;
  tenantConcurrency: number;
}
/** A run as its replica's runner saw it: from its start to its last event, on the machine's clock, in ms. */
type Ran = [task: string, tenant: string, from: number, to: number];
interface Report {
  ran: Ran[];
  /** The CPU seconds the process used since its service started, and the seconds that took. */
  cpu: number;
  seconds: number;
  /** The most queries that waited for a connection of the pool at once, sampled every 20 ms. */
  poolWaiting: number;
  storeErrors: string[];
  /** With STORE_TIMES: each store method's calls, their total and their longest, in ms. */
  store?: Record<string, { calls: number; ms: number; max: number }>;
}

//
// A replica: a process of its own, started by the parent's message and stopped by its next.
//

/** service-load.ts's stand-in: `events` events over `ms`, then an end that spent a little. It keeps what it ran. */
function runner(events: number, ms: number, ran: Ran[]): Runner {
  return {
    async start(task, tenant): Promise<RunHandle> {
      const from = performance.timeOrigin + performance.now();
      return {
        events: (async function* (): AsyncGenerator<JigEvent> {
          for (let seq = 1; seq < events; seq++) {
            yield { v: 1, seq, ts: new Date().toISOString(), type: "text", step: seq, text: `step ${seq} of the stand-in run, with a line of text about as long as a short reply is` };
            await new Promise((done) => setTimeout(done, ms / events));
          }
          // Its end is here: the scheduler stores this event and the outcome after, so the task still holds
          // its slot in the store when this is read, and two of these overlapping are two slots held at once.
          ran.push([task.id, tenant.id, from, performance.timeOrigin + performance.now()]);
          yield { v: 1, seq: events, ts: new Date().toISOString(), type: "end", stop: "end_turn", exitCode: 0, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 }, cost: 0.0001 };
        })(),
        wait: async () => ({ exitCode: 0, timedOut: false }),
        cancel: () => {},
      };
    },
  };
}

/** Times every method of the store, in place. */
function timed(store: Store): NonNullable<Report["store"]> {
  const times: NonNullable<Report["store"]> = {};
  const methods = store as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
    const method = methods[name];
    if (name === "constructor" || name === "poolStats" || typeof method !== "function") continue;
    methods[name] = (...args: unknown[]) => {
      const from = performance.now();
      const result = method.apply(store, args);
      if (!(result instanceof Promise)) return result;
      return result.finally(() => {
        const took = performance.now() - from;
        const row = (times[name] ??= { calls: 0, ms: 0, max: 0 });
        row.calls++;
        row.ms += took;
        row.max = Math.max(row.max, took);
      });
    };
  }
  return times;
}

function replica(): void {
  let api: Service;
  const ran: Ran[] = [];
  let poolWaiting = 0;
  let sampling: NodeJS.Timeout;
  let store: Report["store"];
  let from = 0;
  let cpu = process.cpuUsage();
  process.on("message", async (message: { start?: Start; stop?: true }) => {
    if (message.start) {
      const { database, dataDir, replicaId, tenants, tenantConcurrency } = message.start;
      api = await startService(
        {
          port: 0,
          internal: { port: 0 },
          database,
          dataDir,
          model: "claude-opus-5-5",
          gatewayBaseUrl: "http://127.0.0.1:1/anthropic",
          concurrency: CONCURRENCY,
          replicaId,
          maxStreams: 100_000,
          databasePool: { max: POOL },
          tenants: Array.from({ length: tenants }, (_, n) => ({ id: `load-${n}`, keys: [createHash("sha256").update(key(n)).digest("hex")], concurrency: tenantConcurrency, maxQueued: 1_000_000, maxStreams: 100_000 })),
        },
        { secret: SECRET, runner: runner(EVENTS, RUN_MS, ran), log: createLog("load", { level: "error" }) },
      );
      if (process.env.STORE_TIMES) store = timed(api.store);
      sampling = setInterval(() => (poolWaiting = Math.max(poolWaiting, api.store.poolStats?.().waiting ?? 0)), 20);
      from = performance.now();
      cpu = process.cpuUsage();
      process.send!({ url: api.url });
    } else if (message.stop) {
      const used = process.cpuUsage(cpu);
      const seconds = (performance.now() - from) / 1000;
      clearInterval(sampling);
      const storeErrors = (await api.metrics.registry.render()).split("\n").filter((line) => /^jig_service_(store|lease)_errors_total.* [1-9]/.test(line));
      await api.close();
      const report: Report = { ran, cpu: (used.user + used.system) / 1e6, seconds, poolWaiting, storeErrors, store };
      // Exits once the report is sent, by itself, so a CPU profile is written.
      process.send!({ report }, () => process.disconnect?.());
    }
  });
}

//
// The parent: the clients, and the checks.
//

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} ms`;

/** The next message of a child's, or its exit as a failure. */
function heard<T>(child: ChildProcess): Promise<T> {
  return new Promise((done, failed) => {
    const gone = (code: number | null) => failed(new Error(`a replica exited (${code}) before it answered`));
    child.once("exit", gone);
    child.once("message", (message) => {
      child.off("exit", gone);
      done(message as T);
    });
  });
}

/** The most intervals of `ran` open at once. An end at the instant of a start comes first: that slot was free. */
function mostAtOnce(ran: Ran[]): number {
  const edges = ran.flatMap(([, , from, to]) => [[from, 1], [to, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let most = 0;
  for (const [, edge] of edges) most = Math.max(most, (open += edge));
  return most;
}

async function scenario(replicas: number, tenants: number): Promise<void> {
  // One tenant may fill the service; several may each take half as much again as an even share, so the
  // service's cap and the tenants' own are both reached.
  const tenantConcurrency = tenants === 1 ? CONCURRENCY : Math.ceil((1.5 * CONCURRENCY) / tenants);
  console.log(`\n## ${replicas} replica${replicas > 1 ? "s" : ""}, ${tenants} tenant${tenants > 1 ? "s" : ""} (${tenantConcurrency} at a time each)`);
  const base = mkdtempSync(join(tmpdir(), "jig-replicas-"));
  const database = await postgresDatabase();
  const db = new Pool(database, { max: 2 });
  const children: ChildProcess[] = [];
  const problems: string[] = [];
  try {
    const urls: string[] = [];
    for (let n = 0; n < replicas; n++) {
      const profile = process.env.PROFILE ? ["--cpu-prof", `--cpu-prof-dir=${process.env.PROFILE}`, `--cpu-prof-name=replicas${replicas}-tenants${tenants}-replica${n}.cpuprofile`] : [];
      const child = fork(fileURLToPath(import.meta.url), ["replica"], { execArgv: [...process.execArgv, ...profile] });
      children.push(child);
      child.send({ start: { database, dataDir: join(base, `r${n}`), replicaId: `replica-${n}`, tenants, tenantConcurrency } satisfies Start });
      // One at a time: the first moves the schema on.
      urls.push((await heard<{ url: string }>(child)).url);
    }
    const headers = (tenant: number) => ({ authorization: `Bearer ${key(tenant)}`, "content-type": "application/json" });
    const made: { id: string; tenant: number; replica: number }[] = [];
    const took: number[] = [];
    let next = 0;
    const cpu = process.cpuUsage();
    const from = performance.now();
    // Each task's tenant in turn, and the replica it is posted to changing once the tenants have each had
    // one, so no tenant keeps to one replica.
    const posting = Promise.all(
      Array.from({ length: CLIENTS }, async () => {
        while (next < TASKS) {
          const i = next++;
          const tenant = i % tenants;
          const replica = Math.floor(i / tenants) % replicas;
          const start = performance.now();
          const res = await fetch(`${urls[replica]}/v1/tasks`, { method: "POST", headers: headers(tenant), body: JSON.stringify({ prompt: `task ${i}: a prompt of the length a short request has, say a sentence or two`, maxSteps: 5 }) });
          const body = (await res.json()) as { id?: string; error?: string };
          if (res.status !== 201) throw new Error(`POST /v1/tasks: ${res.status} ${body.error}`);
          took.push(performance.now() - start);
          made.push({ id: body.id!, tenant, replica });
        }
      }),
    ).then(() => (performance.now() - from) / 1000);
    // A follower for one task in ten, through the replica after the one it was posted to (where there is one).
    const followed: Promise<number>[] = [];
    const follow = async ({ id, tenant, replica }: (typeof made)[number]) => {
      const text = await (await fetch(`${urls[(replica + 1) % replicas]}/v1/tasks/${id}/events`, { headers: headers(tenant) })).text();
      const frames = text.split("\n\n").filter((frame) => /^data:/m.test(frame) && !/^event:/m.test(frame));
      const seqs = frames.map((frame) => Number(/^id: ?(\d+)/m.exec(frame)?.[1]));
      if (!/^event: done/m.test(text)) problems.push(`the stream of ${id} ended without done`);
      else if (seqs.length !== EVENTS || seqs.some((seq, at) => seq !== at + 1)) problems.push(`the stream of ${id} missed or repeated an event: ${seqs.join(",")}`);
      return frames.length;
    };
    const watcher = (async () => {
      for (let at = 0; at < TASKS; at += 10) {
        while (made.length <= at) await new Promise((done) => setTimeout(done, 5));
        followed.push(follow(made[at]));
      }
    })();
    const posted = await posting;
    await watcher;
    for (;;) {
      const [open] = (await db.query("SELECT count(*) AS n FROM tasks WHERE status IN ('queued', 'running')")).rows;
      if (Number(open.n) === 0) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const seconds = (performance.now() - from) / 1000;
    const streams = await Promise.all(followed);
    const used = process.cpuUsage(cpu);
    const reports: Report[] = [];
    for (const child of children) {
      child.send({ stop: true });
      reports.push((await heard<{ report: Report }>(child)).report);
      // Its profile, if it writes one, is written as it exits.
      if (child.exitCode === null) await new Promise((done) => child.once("exit", done));
    }

    // What the replicas must have kept together.
    const one = async (sql: string) => Number(Object.values((await db.query(sql)).rows[0])[0]);
    const succeeded = await one("SELECT count(*) FROM tasks WHERE status = 'succeeded'");
    if (succeeded !== TASKS) problems.push(`${TASKS - succeeded} of the tasks didn't succeed`);
    const short = await one(`SELECT count(*) FROM tasks WHERE (SELECT count(*) FROM events WHERE task = tasks.id AND seq BETWEEN 1 AND ${EVENTS}) <> ${EVENTS}`);
    const events = await one("SELECT count(*) FROM events");
    if (short || events !== TASKS * EVENTS) problems.push(`${short} task(s) don't have each of their ${EVENTS} events once (${events} events stored)`);
    const billed = await one("SELECT count(*) FROM usage WHERE status = 'succeeded' AND input = 100 AND output = 50");
    if (billed !== TASKS) problems.push(`the usage ledger has ${billed} rows of a run's, for ${TASKS} tasks`);
    const ran = reports.flatMap((report) => report.ran);
    const twice = ran.length - new Set(ran.map(([id]) => id)).size;
    if (ran.length !== TASKS || twice) problems.push(`the replicas started ${ran.length} runs for ${TASKS} tasks, ${twice} of them a task's second`);
    const most = mostAtOnce(ran);
    if (most > CONCURRENCY) problems.push(`${most} ran at once, past the service's cap of ${CONCURRENCY}`);
    const mostOfTenant = Math.max(...Array.from({ length: tenants }, (_, n) => mostAtOnce(ran.filter(([, tenant]) => tenant === `load-${n}`))));
    if (mostOfTenant > tenantConcurrency) problems.push(`${mostOfTenant} of one tenant's ran at once, past its cap of ${tenantConcurrency}`);
    for (const [n, report] of reports.entries()) if (report.storeErrors.length) problems.push(`replica-${n}'s store errors: ${report.storeErrors.join("; ")}`);

    took.sort((a, b) => a - b);
    console.log(`  created:  ${Math.round(TASKS / posted)}/s, p50 ${ms(quantile(took, 0.5))}, p99 ${ms(quantile(took, 0.99))}, max ${ms(took.at(-1)!)}`);
    console.log(`  all ${TASKS} ended in ${seconds.toFixed(1)} s: ${Math.round(TASKS / seconds)} tasks/s, ${Math.round((TASKS * EVENTS) / seconds)} events/s stored (the runs alone allow ${Math.round((CONCURRENCY * 1000) / RUN_MS)} tasks/s)`);
    console.log(`  runs by replica: ${reports.map((report) => report.ran.length).join(", ")}; most at once ${most} of ${CONCURRENCY}, of one tenant ${mostOfTenant} of ${tenantConcurrency}`);
    console.log(`  CPU, of one core: replicas ${reports.map((report) => `${Math.round((100 * report.cpu) / report.seconds)}%`).join(", ")}; the clients ${Math.round((used.user + used.system) / 1e4 / seconds)}%; most queries waiting for a connection: ${reports.map((report) => report.poolWaiting).join(", ")}`);
    console.log(`  ${streams.length} streams followed to their end, ${streams.reduce((sum, n) => sum + n, 0)} events; ${problems.length ? "PROBLEMS:" : "all succeeded, each task run once, no cap passed, no event missed"}`);
    for (const problem of problems.slice(0, 10)) console.log(`    ${problem}`);
    for (const [n, report] of reports.entries()) {
      if (!report.store) continue;
      const rows = Object.entries(report.store).sort((a, b) => b[1].ms - a[1].ms);
      console.log(`  replica-${n}'s store: ${rows.map(([name, { calls, ms: total, max }]) => `${name} ${calls} × ${(total / calls).toFixed(1)} ms (max ${Math.round(max)})`).join(", ")}`);
    }
    if (problems.length) process.exitCode = 1;
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await db.close();
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[2] === "replica") replica();
else {
  if (!process.env.JIG_TEST_POSTGRES_URL) throw new Error("JIG_TEST_POSTGRES_URL isn't set: replicas share a Postgres database");
  try {
    console.log(`node ${process.version}, ${cpus().length} cores; TASKS=${TASKS} CLIENTS=${CLIENTS} CONCURRENCY=${CONCURRENCY} EVENTS=${EVENTS} RUN_MS=${RUN_MS} POOL=${POOL}`);
    for (const tenants of list("TENANTS", "1,8")) for (const replicas of list("REPLICAS", "1,2,3")) await scenario(replicas, tenants);
  } finally {
    await dropPostgresDatabases();
  }
  process.exit();
}
