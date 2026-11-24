// How much the task service itself takes, with nothing run: its API, its store and its scheduler under many
// tasks at once, the runs a stand-in that writes events and ends (no jig, no container, no model). What a
// real run costs is the runner's and the model's; this is what is left when those are free, so the ceiling
// a deployment can't pass by adding workers. From the repository's root:
//   node bench/service-load.ts                                        SQLite, one replica
//   JIG_TEST_POSTGRES_URL=postgres://... node bench/service-load.ts   Postgres too, with two replicas
// TASKS (2000), CLIENTS (32), CONCURRENCY (64), EVENTS (20) and RUN_MS (200) change the load.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import type { JigEvent, RunHandle, Runner } from "../server/runner.ts";
import { dropPostgresDatabases, postgresDatabase } from "../test/postgres.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const TASKS = env("TASKS", 2000);
const CLIENTS = env("CLIENTS", 32);
const CONCURRENCY = env("CONCURRENCY", 64);
const EVENTS = env("EVENTS", 20);
const RUN_MS = env("RUN_MS", 200);
const KEY = "load-key";
const SECRET = "the load test's secret";

/** A run that writes `events` events over `ms` and ends, having spent a little; or one that waits to be cancelled. */
function runner(events: number, ms: number, held = false): Runner {
  return {
    async start(): Promise<RunHandle> {
      let stop!: () => void;
      const stopped = new Promise<void>((done) => (stop = done));
      return {
        events: (async function* (): AsyncGenerator<JigEvent> {
          if (held) return void (await stopped);
          for (let seq = 1; seq < events; seq++) {
            yield { v: 1, seq, ts: new Date().toISOString(), type: "text", step: seq, text: `step ${seq} of the stand-in run, with a line of text about as long as a short reply is` };
            await new Promise((done) => setTimeout(done, ms / events));
          }
          yield { v: 1, seq: events, ts: new Date().toISOString(), type: "end", stop: "end_turn", exitCode: 0, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 }, cost: 0.0001 };
        })(),
        wait: async () => ({ exitCode: 0, timedOut: false }),
        cancel: stop,
      };
    },
  };
}

const quiet = createLog("load", { level: "error" });

async function service(database: string, dataDir: string, run: Runner, concurrency: number, replicaId?: string): Promise<Service> {
  return startService(
    {
      port: 0,
      internal: { port: 0 },
      database,
      dataDir,
      model: "claude-opus-5-5",
      gatewayBaseUrl: "http://127.0.0.1:1/anthropic",
      concurrency,
      ...(replicaId && { replicaId }),
      maxStreams: 100_000,
      tenants: [{ id: "load", keys: [createHash("sha256").update(KEY).digest("hex")], concurrency, maxQueued: 1_000_000, maxStreams: 100_000 }],
    },
    { secret: SECRET, runner: run, log: quiet },
  );
}

const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} ms`;

/** `count` calls of `one`, `clients` at a time: how many a second, and how long each took. */
async function load(count: number, clients: number, one: (i: number) => Promise<void>): Promise<string> {
  const took: number[] = [];
  let next = 0;
  const from = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      while (next < count) {
        const i = next++;
        const start = performance.now();
        await one(i);
        took.push(performance.now() - start);
      }
    }),
  );
  const seconds = (performance.now() - from) / 1000;
  took.sort((a, b) => a - b);
  return `${Math.round(count / seconds)}/s, p50 ${ms(quantile(took, 0.5))}, p99 ${ms(quantile(took, 0.99))}, max ${ms(took.at(-1)!)}`;
}

async function post(api: Service, i: number): Promise<string> {
  const res = await fetch(`${api.url}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ prompt: `task ${i}: a prompt of the length a short request has, say a sentence or two`, maxSteps: 5 }) });
  const body = (await res.json()) as { id?: string; error?: string };
  if (res.status !== 201) throw new Error(`POST /v1/tasks: ${res.status} ${body.error}`);
  return body.id!;
}

async function scenario(name: string, database: () => Promise<string>, replicas: number): Promise<void> {
  console.log(`\n## ${name}`);
  const base = mkdtempSync(join(tmpdir(), "jig-load-"));
  try {
    // Admission: tasks are made while one run holds the only slot, so nothing else competes for the store.
    let apis = [await service(await database(), join(base, "a"), runner(0, 0, true), 1)];
    const ids: string[] = [];
    console.log(`create (${TASKS} tasks, ${CLIENTS} clients, none running):  ${await load(TASKS, CLIENTS, async (i) => void ids.push(await post(apis[0], i)))}`);
    console.log(`get one of ${TASKS}:                                    ${await load(TASKS, CLIENTS, async (i) => void (await (await fetch(`${apis[0].url}/v1/tasks/${ids[i]}`, { headers })).arrayBuffer()))}`);
    console.log(`list 100 of ${TASKS}, queued:                           ${await load(400, CLIENTS, async () => void (await (await fetch(`${apis[0].url}/v1/tasks?status=queued`, { headers })).arrayBuffer()))}`);
    console.log(`limits:                                               ${await load(400, CLIENTS, async () => void (await (await fetch(`${apis[0].url}/v1/limits`, { headers })).arrayBuffer()))}`);
    await Promise.all(apis.map((api) => api.close()));

    // Throughput: every task runs, CONCURRENCY at a time on each replica, each writing EVENTS events.
    const shared = await database();
    apis = await Promise.all(Array.from({ length: replicas }, (_, n) => service(shared, join(base, `r${n}`), runner(EVENTS, RUN_MS), CONCURRENCY, `replica-${n}`)));
    const made: string[] = [];
    const from = performance.now();
    const posting = load(TASKS, CLIENTS, async (i) => void made.push(await post(apis[i % replicas], i)));
    // A follower for one task in ten, from its start to its end: every event must come, in order, then done.
    const followed: Promise<{ events: number; lag: number }>[] = [];
    const follow = async (id: string, api: Service) => {
      const text = await (await fetch(`${api.url}/v1/tasks/${id}/events`, { headers })).text();
      const frames = text.split("\n\n").filter((frame) => /^data:/m.test(frame) && !/^event:/m.test(frame));
      if (!/^event: done/m.test(text)) throw new Error(`the stream of ${id} ended without done`);
      const seqs = frames.map((frame) => Number(/^id: ?(\d+)/m.exec(frame)?.[1]));
      if (seqs.some((seq, at) => seq !== at + 1)) throw new Error(`the stream of ${id} missed or repeated an event: ${seqs.join(",")}`);
      return { events: frames.length, lag: 0 };
    };
    const watcher = (async () => {
      for (let at = 0; at < TASKS; at += 10) {
        while (made.length <= at) await new Promise((done) => setTimeout(done, 5));
        followed.push(follow(made[at], apis[(at / 10) % replicas]));
      }
    })();
    const created = await posting;
    await watcher;
    const streams = await Promise.all(followed);
    for (;;) {
      const open = (await apis[0].store.counts()).tasks.reduce((sum, row) => sum + row.count, 0);
      if (!open) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    const seconds = (performance.now() - from) / 1000;
    const failed = ((await (await fetch(`${apis[0].url}/v1/tasks?status=error,stopped,cancelled&limit=1`, { headers })).json()) as { tasks: unknown[] }).tasks.length;
    const statuses = failed ? "SOME DIDN'T SUCCEED" : "all succeeded";
    console.log(`run (${replicas} replica${replicas > 1 ? "s" : ""} × ${CONCURRENCY} at a time, ${EVENTS} events and ${RUN_MS} ms a run):`);
    console.log(`  created while running:   ${created}`);
    console.log(`  all ${TASKS} ended in ${seconds.toFixed(1)} s: ${Math.round(TASKS / seconds)} tasks/s, ${Math.round((TASKS * EVENTS) / seconds)} events/s stored (the runs alone allow ${Math.round((replicas * CONCURRENCY * 1000) / RUN_MS)} tasks/s)`);
    console.log(`  ${streams.length} streams followed to their end, ${streams.reduce((sum, stream) => sum + stream.events, 0)} events, none missed; ${statuses}`);
    const errors = (await apis[0].metrics.registry.render()).split("\n").filter((line) => /^jig_service_(store|lease)_errors_total.* [1-9]/.test(line));
    if (errors.length) console.log(`  store errors: ${errors.join("; ")}`);
    await Promise.all(apis.map((api) => api.close()));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const sqlite = mkdtempSync(join(tmpdir(), "jig-load-db-"));
let n = 0;
try {
  console.log(`node ${process.version}, ${(await import("node:os")).cpus().length} cores; TASKS=${TASKS} CLIENTS=${CLIENTS} CONCURRENCY=${CONCURRENCY} EVENTS=${EVENTS} RUN_MS=${RUN_MS}`);
  await scenario("SQLite, one replica", async () => join(sqlite, `${n++}.db`), 1);
  if (process.env.JIG_TEST_POSTGRES_URL) {
    await scenario("Postgres, one replica", postgresDatabase, 1);
    await scenario("Postgres, two replicas", postgresDatabase, 2);
  }
} finally {
  await dropPostgresDatabases();
  rmSync(sqlite, { recursive: true, force: true });
}
process.exit(0);
