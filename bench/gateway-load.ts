// How much the model gateway itself takes: many model calls at once through server/gateway.ts, the provider a
// stand-in that streams a reply as the Messages API does (no model, no key that works anywhere). What a real
// call costs is the model's; this is what the gateway adds to it, and how many calls a second one gateway
// passes before it is the gateway that holds them back. Each gateway is a process of its own, started as a
// deployment starts it (node server/gateway.ts --config ...), the stand-in provider another, the clients this
// one. From the repository's root:
//   node bench/gateway-load.ts                                    the state in memory
//   JIG_TEST_REDIS_URL=redis://... node bench/gateway-load.ts     in Redis too, with one gateway and with two
// REQUESTS (2000), CLIENTS (32), TASKS (40), TENANTS (4), CHUNKS (100), STREAM_MS (250) and BODY_KB (32)
// change the load; TENANT_CONCURRENT and CONCURRENT the caps (by default a quarter over a tenant's even share
// of the clients, and the clients' number); WARM (twice the clients) is how many calls go first, unmeasured,
// so a gateway just started isn't what is timed. GATEWAY_PROF=<dir> writes each gateway's CPU profile there,
// and SCENARIOS=memory,redis1 runs only those (direct, memory, redis1, redis2).
//
// It checks what it measures: every request's body reached the provider byte for byte and with the pool's
// key, every reply came back whole and byte for byte, what the gateway counted for each task and tenant is
// what the provider sent, the provider never held more calls at once than the caps allow, and nothing is left
// in flight after. Any of these failing ends it with status 1.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Usage } from "../src/agent.ts";
import { costOf } from "../src/prices.ts";
import type { GatewayConfig } from "../server/gateway.ts";
import { Redis } from "../server/redis.ts";
import { mintToken } from "../server/token.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const REQUESTS = env("REQUESTS", 2000);
const CLIENTS = env("CLIENTS", 32);
const TASKS = env("TASKS", 40);
const TENANTS = env("TENANTS", 4);
const CHUNKS = Math.max(1, env("CHUNKS", 100));
const STREAM_MS = env("STREAM_MS", 250);
const BODY_KB = env("BODY_KB", 32);
const WARM = env("WARM", 2 * CLIENTS);
// A quarter over the even share: the calls fall on the tenants unevenly, so the cap is reached now and then,
// without the wait for a slot being most of what is measured.
const TENANT_CONCURRENT = env("TENANT_CONCURRENT", Math.ceil((CLIENTS / TENANTS) * 1.25));
const CONCURRENT = env("CONCURRENT", CLIENTS);
const SECRET = "the load test's secret";
const POOL_KEY = "load-pool-key";
const ADMIN = "load-admin-token";
const MODEL = "claude-sonnet-5-5"; // one with a price, so budgets and quotas hold
const ROOT = join(import.meta.dirname, "..");

// The reply to call `i`, the same in the stand-in provider and in the client that checks what came back: a
// stream of CHUNKS text deltas between a message_start and a message_delta whose usage is the call's own.

const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function usageOf(i: number): Usage {
  return { input: 1000 + (i % 977), cacheRead: 100 * (i % 13), cacheWrite: 10 * (i % 7), output: 3 * CHUNKS + (i % 101) };
}

function head(i: number): string {
  const { input, cacheRead, cacheWrite } = usageOf(i);
  const usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 };
  return (
    event("message_start", { message: { id: `msg_load_${i}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }) +
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    event("ping", {})
  );
}

/** The deltas are every call's own: about the dozen tokens of text the API sends in one, not all ASCII. */
const DELTAS = Array.from({ length: CHUNKS }, (_, k) => Buffer.from(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: ` part ${k} of the reply, "quoted" and with a line's end\n and an é` } })));
const MIDDLE = Buffer.concat(DELTAS);

function tail(i: number): string {
  return event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usageOf(i).output } }) + event("message_stop", {});
}

/** The stand-in provider, a process of its own: `node bench/gateway-load.ts upstream` prints its URL and serves until killed. */
async function upstream(): Promise<void> {
  const stats = { requests: 0, wrong: [] as string[], most: 0, mostOfTenant: 0 };
  let inflight = 0;
  const tenants = new Map<string, number>();
  const server = createServer((req, res) => {
    if (req.method === "GET") return void res.end(JSON.stringify(stats));
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const i = Number(req.headers["x-load-call"]);
      const tenant = String(req.headers["x-load-tenant"]);
      stats.requests++;
      // What must hold of every request, said once each (the first few): the client fails on any.
      const wrong = (what: string) => stats.wrong.length < 5 && stats.wrong.push(`call ${i}: ${what}`);
      if (req.url !== "/v1/messages?beta=true") wrong(`the path was ${req.url}`);
      if (req.headers["x-api-key"] !== POOL_KEY || req.headers.authorization) wrong("the credential was not the pool's key alone");
      if (createHash("sha256").update(Buffer.concat(chunks)).digest("hex") !== req.headers["x-load-sha256"]) wrong("the body was not the bytes sent");
      stats.most = Math.max(stats.most, ++inflight);
      tenants.set(tenant, (tenants.get(tenant) ?? 0) + 1);
      stats.mostOfTenant = Math.max(stats.mostOfTenant, tenants.get(tenant)!);
      res.once("close", () => {
        inflight--;
        tenants.set(tenant, tenants.get(tenant)! - 1);
      });
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_load_${i}` });
      // The start of the reply at once, then each chunk at its time from the start, the last with the reply's
      // end after STREAM_MS. A late timer doesn't make the stream longer: the chunks that are due go together.
      res.write(head(i));
      const start = performance.now();
      const due = (k: number) => start + ((k + 1) * STREAM_MS) / CHUNKS;
      let k = 0;
      const write = () => {
        if (res.destroyed) return;
        while (k < CHUNKS && due(k) <= performance.now()) res.write(DELTAS[k++]);
        if (k === CHUNKS) return void res.end(tail(i));
        setTimeout(write, Math.max(0, due(k) - performance.now()));
      };
      write();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  console.log(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

/** A child process to end with the scenario, and its first line on `stream` that `pattern` matches. */
function child(args: string[], childEnv: NodeJS.ProcessEnv, stream: "stdout" | "stderr", pattern: RegExp): Promise<{ process: ChildProcess; match: RegExpExecArray }> {
  // Its environment is what it is given, and no more: no key of a real provider goes near it.
  const started = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...childEnv }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    started.once("error", reject);
    started.once("exit", (code) => reject(new Error(`node ${args.join(" ")} ended with ${code} before it was up`)));
    started[stream === "stdout" ? "stderr" : "stdout"]!.pipe(process.stderr);
    createInterface(started[stream]!).on("line", (line) => {
      const match = pattern.exec(line);
      if (match) resolve({ process: started, match });
      else process.stderr.write(`${line}\n`);
    });
  });
}

async function end(started: ChildProcess): Promise<void> {
  if (started.exitCode !== null) return;
  started.kill("SIGTERM");
  await new Promise((done) => started.once("exit", done));
}

/** The CPU seconds a process has used, its own and the kernel's for it; undefined where /proc doesn't say (not Linux). */
function cpuSeconds(pid: number): number | undefined {
  try {
    // After the command's name, which may hold spaces: utime and stime are the 12th and 13th fields, in ticks of 1/100 s.
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return undefined;
  }
}

interface Target {
  url: string;
  metricsUrl?: string;
  pid?: number;
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? NaN;
const ms = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} ms`;
const spread = (took: number[]) => (took.sort((a, b) => a - b), `p50 ${ms(quantile(took, 0.5))}, p99 ${ms(quantile(took, 0.99))}, max ${ms(took.at(-1)!)}`);

/** The task of call `i` and its tenant: scattered, so the tenants' calls in flight rise and fall. */
const taskOf = (i: number) => (Math.imul(i + 1, 2654435761) >>> 0) % TASKS;
const tenantOf = (task: number) => `tenant-${task % TENANTS}`;

/** A request body as jig sends one, of BODY_KB: a model, a long conversation, spaces and escapes that a rewrite would lose. */
function bodyOf(i: number, padding: string): Buffer {
  return Buffer.from(`{"model":"${MODEL}",  "max_tokens":64000,"stream":true,"messages":[{"role":"user","content":"call ${i} é \\u00e9 ${padding}"}]}`);
}

async function json(url: string, credential: string): Promise<any> {
  const res = await fetch(url, { headers: { "x-api-key": credential } });
  if (res.status !== 200) throw new Error(`GET ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** True when two sums of the same amounts, added in another order or by Redis, are the same amount. */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * WARM calls unmeasured, then REQUESTS calls, CLIENTS at a time, to `targets` in turn (the gateways, or the
 * provider itself with `direct`), then the checks, of them all. Answers what was wrong, which is nothing
 * when all is well.
 */
async function load(targets: Target[], provider: string, direct: boolean): Promise<string[]> {
  const wrong: string[] = [];
  const failed = (what: string) => wrong.length < 10 && wrong.push(what);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  // Every other task has a budget, as a task with maxCostUsd does: the gateway reads its spending before each call.
  const tokens = Array.from({ length: TASKS }, (_, task) => mintToken(SECRET, { tenant: tenantOf(task), task: `task-${task}`, exp, budgetUsd: task % 2 ? 1000 : null }));
  const padding = "The conversation so far, as long as a few turns of a coding task make it. ".repeat(Math.ceil((BODY_KB * 1024) / 75)).slice(0, BODY_KB * 1024);
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const firstByte: number[] = [];
  const whole: number[] = [];
  const day = new Date().toISOString().slice(0, 10);

  const call = (i: number): Promise<void> =>
    new Promise((done) => {
      const task = taskOf(i);
      const body = bodyOf(i, padding);
      const start = performance.now();
      let first: number | undefined;
      const target = targets[i % targets.length];
      const req = request(`${direct ? target.url : `${target.url}/anthropic`}/v1/messages?beta=true`, {
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": direct ? POOL_KEY : tokens[task],
          "x-load-call": String(i),
          "x-load-tenant": tenantOf(task),
          "x-load-sha256": createHash("sha256").update(body).digest("hex"),
          "content-length": String(body.length),
        },
      });
      req.on("error", (err) => (failed(`call ${i}: ${err.message}`), done()));
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          first ??= performance.now();
          chunks.push(chunk);
        });
        res.on("error", (err) => (failed(`call ${i}: its reply broke off: ${err.message}`), done()));
        res.on("end", () => {
          const ended = performance.now();
          const reply = Buffer.concat(chunks);
          if (res.statusCode !== 200) failed(`call ${i}: ${res.statusCode} ${reply.toString().slice(0, 200)}`);
          else if (!reply.equals(Buffer.concat([Buffer.from(head(i)), MIDDLE, Buffer.from(tail(i))]))) failed(`call ${i}: its reply is not the bytes the provider sent`);
          else {
            firstByte.push(first! - start);
            whole.push(ended - start);
          }
          done();
        });
      });
      req.end(body);
    });

  let next = 0;
  const calls = (until: number) =>
    Promise.all(
      Array.from({ length: CLIENTS }, async () => {
        while (next < until) await call(next++);
      }),
    );
  await calls(WARM);
  firstByte.length = whole.length = 0;
  const before = targets.map(({ pid }) => (pid ? cpuSeconds(pid) : undefined));
  const from = performance.now();
  await calls(WARM + REQUESTS);
  const seconds = (performance.now() - from) / 1000;
  agent.destroy();
  console.log(`  ${REQUESTS} calls, ${CLIENTS} at a time: ${Math.round(REQUESTS / seconds)}/s${STREAM_MS ? ` (the streams alone allow ${Math.round((CLIENTS * 1000) / STREAM_MS)}/s)` : ""}`);
  if (firstByte.length) console.log(`  to the first byte: ${spread(firstByte)}; to the end: ${spread(whole)}`);
  const used = targets.map(({ pid }, n) => (pid && before[n] !== undefined ? cpuSeconds(pid)! - before[n] : undefined));
  if (used.every((cpu) => cpu !== undefined) && used.length) {
    const total = used.reduce((sum, cpu) => sum + cpu!, 0);
    console.log(`  the gateway${used.length > 1 ? "s'" : "'s"} CPU: ${used.map((cpu) => `${cpu!.toFixed(2)} s`).join(" + ")}, ${((total * 1000) / REQUESTS).toFixed(2)} ms a call, so a core passes about ${Math.round(REQUESTS / total)} such calls a second`);
  }

  const seen = (await (await fetch(provider)).json()) as { requests: number; wrong: string[]; most: number; mostOfTenant: number };
  for (const what of seen.wrong) failed(`at the provider, ${what}`);
  if (seen.requests !== WARM + REQUESTS) failed(`the provider had ${seen.requests} requests, not ${WARM + REQUESTS}`);
  if (direct) return wrong;
  if (seen.most > CONCURRENT) failed(`the provider held ${seen.most} calls at once, over the cap of ${CONCURRENT}`);
  if (seen.mostOfTenant > TENANT_CONCURRENT) failed(`the provider held ${seen.mostOfTenant} calls of one tenant at once, over its cap of ${TENANT_CONCURRENT}`);

  // What the gateway counted against what was sent: each task's, by its own token, and each tenant's day.
  const sent = Array.from({ length: TASKS }, () => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 }));
  for (let i = 0; i < WARM + REQUESTS; i++) {
    const usage = usageOf(i);
    const total = sent[taskOf(i)];
    total.requests++;
    for (const field of ["input", "cacheRead", "cacheWrite", "output"] as const) total[field] += usage[field];
    total.costUsd += costOf(MODEL, usage)!;
  }
  const same = (who: string, counted: Record<string, number>, total: (typeof sent)[number]) => {
    const fields = Object.keys(total) as (keyof typeof total)[];
    if (!fields.every((field) => (field === "costUsd" ? close(counted[field], total[field]) : counted[field] === total[field]))) failed(`${who} was counted ${JSON.stringify(counted)}, and was sent ${JSON.stringify(total)}`);
  };
  await Promise.all(
    sent.map(async (total, task) => {
      const { requests, usage, costUsd, unpriced } = await json(`${targets[task % targets.length].url}/usage/task-${task}`, tokens[task]);
      same(`task-${task}`, { requests, ...usage, costUsd }, total);
      if (unpriced) failed(`task-${task} had ${unpriced} replies without a price`);
    }),
  );
  for (let tenant = 0; tenant < TENANTS; tenant++) {
    const total = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };
    sent.forEach((task, n) => n % TENANTS === tenant && (Object.keys(total) as (keyof typeof total)[]).forEach((field) => (total[field] += task[field])));
    // From the day the load began to today, should midnight (UTC) have come between.
    const counted = await json(`${targets[0].url}/usage?tenant=tenant-${tenant}&from=${day}&to=${new Date().toISOString().slice(0, 10)}`, ADMIN);
    same(`tenant-${tenant}`, counted.total, total);
  }

  // Nothing left: no call in flight or waiting on any gateway, and no read or write of Redis that failed.
  let waited = 0;
  let waitedSeconds = 0;
  for (const { metricsUrl } of targets) {
    const lines = (await (await fetch(`${metricsUrl}/metrics`)).text()).split("\n");
    for (const line of lines) {
      if (/^jig_gateway_(inflight|waiting|state_errors_total|state_late_releases_total)(\{.*\})? [^0]/.test(line)) failed(`after the load, ${line}`);
      if (/^jig_gateway_requests_total\{.*status="(?!200")/.test(line)) failed(`after the load, ${line}`);
      // A call that never waited for a slot is in the bucket of 5 ms; the wait of those that did is in the sum.
      if (line.startsWith("jig_gateway_queue_seconds_sum")) waitedSeconds += Number(line.split(" ").pop());
      if (line.startsWith("jig_gateway_queue_seconds_bucket") && line.includes('le="0.005"')) waited -= Number(line.split(" ").pop());
      if (line.startsWith("jig_gateway_queue_seconds_count")) waited += Number(line.split(" ").pop());
    }
  }
  console.log(`  at the provider at once: ${seen.most} of ${CONCURRENT} in all, ${seen.mostOfTenant} of a tenant's ${TENANT_CONCURRENT}; ${waited} calls waited over 5 ms for a slot (${ms((waitedSeconds * 1000) / (WARM + REQUESTS))} a call over them all)`);
  if (!wrong.length) console.log(`  every body and reply byte for byte, the spending of ${TASKS} tasks and ${TENANTS} tenants as sent, nothing left in flight`);
  return wrong;
}

async function scenario(name: string, gateways: number, redis?: string): Promise<boolean> {
  console.log(`\n## ${name}`);
  const dir = mkdtempSync(join(tmpdir(), "jig-gateway-load-"));
  const prefix = `jig:load:${randomUUID()}:`;
  const children: ChildProcess[] = [];
  try {
    const provider = await child([fileURLToPath(import.meta.url), "upstream"], { CHUNKS: String(CHUNKS), STREAM_MS: String(STREAM_MS) }, "stdout", /^(http:\S+)$/);
    children.push(provider.process);
    const providerUrl = provider.match[1];
    const config: GatewayConfig = {
      listen: { port: 0 },
      metrics: { port: 0 },
      upstream: { baseUrl: providerUrl, keyEnv: ["LOAD_POOL_KEY"] },
      // Every limit a deployment sets is set, so each is checked on every call; only the caps are near enough to be reached.
      limits: { concurrent: CONCURRENT, requestsPerMinute: 60_000_000, tenantDefaults: { concurrent: TENANT_CONCURRENT, requestsPerMinute: 60_000_000, dailyUsd: 1_000_000, monthlyUsd: 1_000_000 } },
      adminTokenEnv: "LOAD_ADMIN",
      ...(redis && { state: { redis, prefix } }),
    };
    writeFileSync(join(dir, "gateway.json"), JSON.stringify(config));
    const prof = process.env.GATEWAY_PROF;
    if (prof) mkdirSync(prof, { recursive: true });
    const targets: Target[] = [];
    for (let n = 0; n < gateways; n++) {
      const flags = prof ? ["--cpu-prof", `--cpu-prof-dir=${prof}`, `--cpu-prof-name=${name.replace(/\W+/g, "-")}-${n}.cpuprofile`] : [];
      const gateway = await child([...flags, "server/gateway.ts", "--config", join(dir, "gateway.json")], { JIG_GATEWAY_SECRET: SECRET, LOAD_POOL_KEY: POOL_KEY, LOAD_ADMIN: ADMIN }, "stderr", /listening on (\S+) \(metrics=(\S+)\)/);
      children.push(gateway.process);
      targets.push({ url: gateway.match[1], metricsUrl: gateway.match[2], pid: gateway.process.pid });
    }
    const wrong = await load(gateways ? targets : [{ url: providerUrl }], providerUrl, !gateways);
    if (redis && !wrong.length) {
      // The slots are leases in Redis: none may be left there either, once the gateways have given theirs back.
      const client = new Redis(redis);
      const left = (await Promise.all(["inflight", ...Array.from({ length: TENANTS }, (_, n) => `inflight:tenant-${n}`)].map((key) => client.command(["ZCARD", prefix + key])))) as number[];
      client.close();
      if (left.some(Boolean)) wrong.push(`slots left in Redis: ${left.join(", ")}`);
    }
    for (const what of wrong) console.log(`  WRONG: ${what}`);
    return !wrong.length;
  } finally {
    // The gateways first, and to their end, so each writes its profile.
    for (const started of children.reverse()) await end(started);
    if (redis) {
      const client = new Redis(redis);
      const keys = (await client.command(["KEYS", `${prefix}*`])) as string[];
      if (keys.length) await client.command(["DEL", ...keys]);
      client.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(`node ${process.version}, ${cpus().length} cores; REQUESTS=${REQUESTS} CLIENTS=${CLIENTS} TASKS=${TASKS} TENANTS=${TENANTS} CHUNKS=${CHUNKS} STREAM_MS=${STREAM_MS} BODY_KB=${BODY_KB}`);
  const redis = process.env.JIG_TEST_REDIS_URL;
  const only = process.env.SCENARIOS?.split(",");
  const scenarios: [string, string, number, string?][] = [
    // What the clients and the provider do with no gateway between them: past this, it is they that are measured.
    ["direct", "No gateway: the clients to the provider", 0],
    ["memory", "One gateway, its state in memory", 1],
    ...(redis ? ([["redis1", "One gateway, its state in Redis", 1, redis], ["redis2", "Two gateways sharing the Redis", 2, redis]] as [string, string, number, string][]) : []),
  ];
  let well = true;
  for (const [id, name, gateways, state] of scenarios) {
    if (!only || only.includes(id)) well = (await scenario(name, gateways, state)) && well;
  }
  process.exit(well ? 0 : 1);
}

if (process.argv[2] === "upstream") await upstream();
else await main();
