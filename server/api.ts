import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Runner, workspaceProblem } from "./runner.ts";
import { DockerRunner, type DockerRunnerConfig } from "./runners/docker.ts";
import { KubernetesRunner, type KubernetesRunnerConfig } from "./runners/k8s.ts";
import { LocalRunner } from "./runners/local.ts";
import { Scheduler, type Update } from "./scheduler.ts";
import { FINISHED, openStore, STATUSES, type Store, type Limits, type Task, type TaskSpec, type TaskStatus, type Tenant } from "./store.ts";

// The task service's HTTP API (docs/server.md): tenants create tasks, follow their events and cancel them,
// each with its own API key, and sees only its own tasks. `node server/api.ts --config <file>` runs it.

export interface TenantConfig {
  id: string;
  /** SHA-256 hashes of the tenant's API keys, in hex: the config holds no key itself. */
  keys: string[];
  concurrency?: number;
  maxSteps?: number;
  timeLimit?: number;
  budgetUsd?: number | null;
  maxQueued?: number;
}

export interface Config {
  host?: string;
  port?: number;
  /** The SQLite file, or a Postgres URL (postgres://...), which replicas of the service share. */
  database: string;
  /** Where each task's folder goes. */
  dataDir: string;
  /** Tasks that may run at once, across tenants (and across replicas sharing the database). */
  concurrency?: number;
  /** The model a task gets if it names none. */
  model?: string;
  gatewayBaseUrl: string;
  graceSeconds?: number;
  jig?: string[];
  gitProtocols?: string[];
  maxBodyBytes?: number;
  heartbeatSeconds?: number;
  /** Where tasks run: as processes on this machine (local, the default), in Docker containers or as Kubernetes Jobs. */
  runner?: "local" | "docker" | "kubernetes";
  docker?: Omit<DockerRunnerConfig, Shared>;
  kubernetes?: Omit<KubernetesRunnerConfig, Shared>;
  /** This replica's name in the database, unique among those running (default: host, process id and a random part). */
  replicaId?: string;
  /** How long a replica's hold on a running task lasts unless renewed, in seconds. */
  leaseSeconds?: number;
  /** The most events of a task's that are stored. */
  maxEvents?: number;
  /** Keep each task's folder after it ends. */
  keepTaskDirs?: boolean;
  tenants: TenantConfig[];
}

/** What every runner takes from the config's top level. */
type Shared = "dataDir" | "gatewayBaseUrl" | "gatewaySecret" | "graceSeconds" | "gitProtocols";

const DEFAULT_LIMITS: Required<Limits> = { concurrency: 2, maxSteps: 50, timeLimit: 1800, budgetUsd: null, maxQueued: 1000 };
const MAX_PROMPT = 100_000;
const MAX_FILES = 1_000;

export interface Service {
  url: string;
  server: Server;
  store: Store;
  scheduler: Scheduler;
  close(): Promise<void>;
}

/**
 * Checks the config, opens the store, puts the config's tenants in it and shuts out those it no longer
 * lists, ends the tasks of replicas that are gone, and listens. The runner is the local one unless one is given (a test's).
 */
export async function startService(config: Config, { secret, runner }: { secret: string; runner?: Runner }): Promise<Service> {
  checkConfig(config);
  runner ??= runnerFor(config, secret);
  const store = await openStore(config.database);
  let scheduler: Scheduler;
  try {
    for (const tenant of config.tenants) {
      const limits: Limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(tenant).filter(([key]) => key in DEFAULT_LIMITS)) };
      await store.putTenant({ id: tenant.id, limits }, tenant.keys.map((key) => key.toLowerCase()));
    }
    // A tenant taken out of the config is revoked: its keys stop working and what it queued won't run.
    const retired = await store.retireTenants(config.tenants.map((tenant) => tenant.id));
    if (retired) console.error(`jig service: ${retired} queued task(s) of tenants no longer in the config cancelled`);
    const { concurrency = 4, replicaId, leaseSeconds = 30, maxEvents, keepTaskDirs } = config;
    scheduler = new Scheduler(store, runner, { concurrency, replicaId, leaseMs: leaseSeconds * 1000, maxEvents, keepTaskDirs });
    const expired = await scheduler.start();
    if (expired.length) console.error(`jig service: ${expired.length} task(s) whose replica is gone (a crash, or a kill) marked as errors`);
  } catch (err) {
    await store.close();
    throw err;
  }
  const server = createServer((req, res) => {
    handle(req, res, { store, scheduler, model: config.model ?? "deepseek-flash", maxBody: config.maxBodyBytes ?? 1024 * 1024, heartbeatMs: (config.heartbeatSeconds ?? 15) * 1000 }).catch((err) => {
      if (!res.headersSent) reply(res, 500, { error: "Internal error" });
      else res.end();
      console.error(err);
    });
  });
  await new Promise<void>((done) => server.listen(config.port ?? 8080, config.host ?? "127.0.0.1", done));
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    server,
    store,
    scheduler,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await scheduler.close();
      await store.close();
    },
  };
}

function runnerFor(config: Config, secret: string): Runner {
  const shared = { dataDir: config.dataDir, gatewayBaseUrl: config.gatewayBaseUrl, gatewaySecret: secret, graceSeconds: config.graceSeconds ?? 30, gitProtocols: config.gitProtocols };
  const { runner = "local", docker, kubernetes } = config;
  if (runner === "local") return new LocalRunner({ ...shared, jig: config.jig ?? [process.execPath, join(import.meta.dirname, "..", "src", "cli.ts")] });
  if (runner === "docker" && docker?.image && docker.network) return new DockerRunner({ ...docker, ...shared });
  if (runner === "docker") throw new Error('The docker runner needs "docker": {"image", "network"}: the worker image, and an internal network the gateway is on');
  if (runner === "kubernetes" && kubernetes?.image) return new KubernetesRunner({ ...kubernetes, ...shared });
  if (runner === "kubernetes") throw new Error('The kubernetes runner needs "kubernetes": {"image"}: the worker image');
  throw new Error(`runner must be local, docker or kubernetes, not ${JSON.stringify(runner)}`);
}

/** Throws with what is wrong if the config isn't one the service can run with. */
export function checkConfig(config: Config): void {
  const problem = configProblem(config);
  if (problem) throw new Error(`The config's ${problem}`);
}

function configProblem(config: Config): string | undefined {
  if (!isObject(config)) return "top level must be a JSON object";
  const fields = config as unknown as Record<string, unknown>;
  const text = (name: string, value: unknown, required: boolean) =>
    value === undefined ? (required ? `${name} is missing` : undefined) : typeof value === "string" && value ? undefined : `${name} must be a string that isn't empty`;
  const whole = (name: string, value: unknown, least: number, most = Number.MAX_SAFE_INTEGER) =>
    value === undefined || (Number.isInteger(value) && (value as number) >= least && (value as number) <= most) ? undefined : `${name} must be a whole number from ${least}${most < Number.MAX_SAFE_INTEGER ? ` to ${most}` : " up"}, not ${JSON.stringify(value)}`;
  const positive = (name: string, value: unknown, zero = false) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && (zero ? value >= 0 : value > 0)) ? undefined : `${name} must be a number over ${zero ? "or at " : ""}0, not ${JSON.stringify(value)}`;
  const strings = (name: string, value: unknown) =>
    value === undefined || (Array.isArray(value) && value.length && value.every((item) => typeof item === "string" && item)) ? undefined : `${name} must be a list of strings`;
  const problem =
    text("database", config.database, true) ??
    text("dataDir", config.dataDir, true) ??
    text("gatewayBaseUrl", config.gatewayBaseUrl, true) ??
    (/^https?:\/\//i.test(config.gatewayBaseUrl) && URL.canParse(config.gatewayBaseUrl) ? undefined : `gatewayBaseUrl must be an http or https URL, not ${JSON.stringify(config.gatewayBaseUrl)}`) ??
    text("host", config.host, false) ??
    whole("port", config.port, 0, 65535) ??
    whole("concurrency", config.concurrency, 1) ??
    text("model", config.model, false) ??
    positive("graceSeconds", config.graceSeconds, true) ??
    strings("jig", config.jig) ??
    strings("gitProtocols", config.gitProtocols) ??
    whole("maxBodyBytes", config.maxBodyBytes, 1) ??
    positive("heartbeatSeconds", config.heartbeatSeconds) ??
    text("replicaId", config.replicaId, false) ??
    positive("leaseSeconds", config.leaseSeconds) ??
    whole("maxEvents", config.maxEvents, 1) ??
    (fields.keepTaskDirs === undefined || typeof fields.keepTaskDirs === "boolean" ? undefined : "keepTaskDirs must be true or false") ??
    (Array.isArray(config.tenants) ? undefined : "tenants must be a list");
  if (problem) return problem;
  const tenants = new Set<string>();
  /** Which tenant each key opens: one key may open only one. */
  const owners = new Map<string, string>();
  for (const [i, tenant] of config.tenants.entries()) {
    const at = `tenants[${i}]`;
    if (!isObject(tenant)) return `${at} must be an object`;
    const problem =
      text(`${at}.id`, tenant.id, true) ??
      (tenants.has(tenant.id) ? `${at}.id ${JSON.stringify(tenant.id)} is another tenant's too` : undefined) ??
      (Array.isArray(tenant.keys) ? undefined : `${at}.keys must be a list of the SHA-256 hashes of its API keys, in hex`) ??
      whole(`${at}.concurrency`, tenant.concurrency, 0) ??
      whole(`${at}.maxSteps`, tenant.maxSteps, 1) ??
      whole(`${at}.timeLimit`, tenant.timeLimit, 1) ??
      (tenant.budgetUsd === null ? undefined : positive(`${at}.budgetUsd`, tenant.budgetUsd)) ??
      whole(`${at}.maxQueued`, tenant.maxQueued, 0);
    if (problem) return problem;
    tenants.add(tenant.id);
    for (const [j, key] of tenant.keys.entries()) {
      if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) return `${at}.keys[${j}] must be a key's SHA-256 hash, 64 hex digits (printf %s "$KEY" | sha256sum)`;
      const owner = owners.get(key.toLowerCase());
      if (owner !== undefined) return `${at}.keys[${j}] is ${owner === tenant.id ? "there twice" : `tenant ${owner}'s key too: a key opens one tenant`}`;
      owners.set(key.toLowerCase(), tenant.id);
    }
  }
  return undefined;
}

interface Context {
  store: Store;
  scheduler: Scheduler;
  model: string;
  maxBody: number;
  heartbeatMs: number;
}

async function handle(req: IncomingMessage, res: ServerResponse, context: Context): Promise<void> {
  const url = new URL(req.url ?? "/", "http://service");
  if (url.pathname === "/healthz") return reply(res, 200, { ok: true });
  const key = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const tenant = key && (await context.store.tenantByKey(createHash("sha256").update(key).digest("hex")));
  if (!tenant) return reply(res, 401, { error: "A tenant's API key is needed: Authorization: Bearer <key>" }, { "www-authenticate": "Bearer" });

  if (url.pathname === "/v1/tasks") {
    if (req.method === "POST") return createTask(req, res, tenant, context);
    if (req.method !== "GET") return reply(res, 405, { error: "Use GET or POST" });
    const status = url.searchParams.get("status") ?? undefined;
    if (status !== undefined && !STATUSES.includes(status as TaskStatus)) return reply(res, 400, { error: `status must be one of: ${STATUSES.join(", ")}` });
    const before = url.searchParams.get("before") ?? undefined;
    if (before !== undefined && !/^[\w-]{1,100}$/.test(before)) return reply(res, 400, { error: "before must be a task's id" });
    const limit = Number(url.searchParams.get("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return reply(res, 400, { error: "limit must be a whole number from 1 to 100" });
    // The prompts can be long: a list leaves them out unless asked.
    const full = ["1", "true"].includes(url.searchParams.get("full") ?? "");
    const tasks = await context.store.tasks(tenant.id, { status: status as TaskStatus | undefined, before, limit, prompts: full });
    // A full page may have more after it: the next is read with before=<next>.
    return reply(res, 200, { tasks: tasks.map((task) => view(task, { prompt: full })), ...(tasks.length === limit && { next: tasks.at(-1)!.id }) });
  }
  const match = /^\/v1\/tasks\/([\w-]+)(\/cancel|\/events)?$/.exec(url.pathname);
  // Another tenant's task is as missing as one that never was.
  const task = match && (await context.store.task(match[1]));
  if (!match || !task || task.tenant !== tenant.id) return reply(res, 404, { error: "No such task" });
  const [, , action] = match;
  if (!action) return req.method === "GET" ? reply(res, 200, view(task, { prompt: true, stats: true })) : reply(res, 405, { error: "Use GET" });
  if (action === "/cancel") {
    if (req.method !== "POST") return reply(res, 405, { error: "Use POST" });
    if (FINISHED.has(task.status)) return reply(res, 409, { error: `The task has already ended: ${task.status}`, id: task.id, status: task.status });
    const status = await context.scheduler.cancel(task);
    return reply(res, status === "cancelled" ? 200 : 202, { id: task.id, status });
  }
  if (req.method !== "GET") return reply(res, 405, { error: "Use GET" });
  const after = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  if (typeof after !== "string" || !/^\d{1,9}$/.test(after)) return reply(res, 400, { error: "Last-Event-ID and after must be an event's seq" });
  return streamEvents(req, res, task, Number(after), context);
}

async function createTask(req: IncomingMessage, res: ServerResponse, tenant: Tenant, context: Context): Promise<void> {
  const body = await readBody(req, context.maxBody);
  if (body === undefined) {
    res.setHeader("connection", "close");
    return reply(res, 413, { error: `The body is over ${context.maxBody} bytes` });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: "The body isn't JSON" });
  }
  const spec = taskSpec(input, tenant, context.model);
  if (typeof spec === "string") return reply(res, 400, { error: spec });
  // A queue without an end would fill the disk, and a tenant's waits only grow.
  const most = tenant.limits.maxQueued ?? DEFAULT_LIMITS.maxQueued;
  if ((await context.store.queuedCount(tenant.id)) >= most) return reply(res, 429, { error: `The tenant has ${most} tasks queued, the most it may: wait for some to start` });
  const task = await context.store.createTask(tenant.id, spec);
  void context.scheduler.poke();
  reply(res, 201, { id: task.id, status: task.status });
}

/** The request's body, or undefined once it is over `max` bytes (the rest isn't read). */
async function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  if (Number(req.headers["content-length"]) > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A task's spec from a request, with the tenant's limits as the defaults and the bounds; or what is wrong. */
export function taskSpec(input: unknown, tenant: Tenant, defaultModel: string): TaskSpec | string {
  if (!isObject(input)) return "The body must be a JSON object";
  const unknown = Object.keys(input).find((key) => !["prompt", "workspace", "maxSteps", "timeLimit", "model"].includes(key));
  if (unknown) return `Unknown field: ${unknown}`;
  const { prompt, workspace, maxSteps = tenant.limits.maxSteps, timeLimit = tenant.limits.timeLimit, model = defaultModel } = input;
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt must be a string that isn't empty";
  if (prompt.length > MAX_PROMPT) return `prompt must be at most ${MAX_PROMPT} characters`;
  // Postgres text can't hold one, and jig has no use for it: refused on every store alike.
  if (prompt.includes("\0")) return "prompt must not hold a NUL character (\\u0000)";
  if (!Number.isInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > tenant.limits.maxSteps) return `maxSteps must be a whole number from 1 to ${tenant.limits.maxSteps}`;
  if (!Number.isInteger(timeLimit) || (timeLimit as number) < 1 || (timeLimit as number) > tenant.limits.timeLimit) return `timeLimit must be a whole number of seconds from 1 to ${tenant.limits.timeLimit}`;
  // The gateway serves the Anthropic API, which jig uses for Claude and DeepSeek models.
  if (typeof model !== "string" || !/^(claude|deepseek)[\w.:-]{0,100}$/.test(model)) return "model must be a Claude or DeepSeek model's id";
  if (workspace === undefined) return { prompt, maxSteps: maxSteps as number, timeLimit: timeLimit as number, model };
  if (!isObject(workspace)) return "workspace must be an object";
  const extra = Object.keys(workspace).find((key) => !["files", "git", "ref"].includes(key));
  if (extra) return `Unknown field: workspace.${extra}`;
  const { files, git, ref } = workspace;
  if (files !== undefined && git !== undefined) return "workspace takes files or git, not both";
  if (files !== undefined) {
    if (!isObject(files)) return "workspace.files must map paths to their contents";
    const entries = Object.entries(files);
    if (entries.length > MAX_FILES) return `workspace.files may hold at most ${MAX_FILES} files`;
    for (const [path, contents] of entries) {
      const problem = workspaceProblem(path);
      if (problem) return `workspace.files: ${JSON.stringify(path)} ${problem}`;
      if (typeof contents !== "string") return `workspace.files: ${JSON.stringify(path)} must have a string as its contents`;
    }
  }
  if (git !== undefined && (typeof git !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(git) || git.length > 2000)) return "workspace.git must be a repository's URL";
  if (ref !== undefined && (git === undefined || typeof ref !== "string" || !/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-"))) return "workspace.ref must be a branch or tag of workspace.git";
  return { prompt, workspace: { files, git, ref } as TaskSpec["workspace"], maxSteps: maxSteps as number, timeLimit: timeLimit as number, model };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A task as the API shows it; the list leaves out the stats, and the prompt unless asked. */
function view(task: Task, show: { prompt?: boolean; stats?: boolean }) {
  const { spec, tenant, stats, ...rest } = task;
  return { ...rest, ...(show.prompt && { prompt: spec.prompt }), model: spec.model, maxSteps: spec.maxSteps, timeLimit: spec.timeLimit, ...(show.stats && { stats }) };
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}

/**
 * The task's events after `after` as server-sent events (each one's id its seq): those stored, then the
 * live ones, then `event: done` with the status it ended in, and the stream ends. A client that reconnects
 * with Last-Event-ID gets only what came after. The task may run on this replica, whose scheduler passes on
 * its events as they are stored, or on another, whose events and end the store announces; while it can't
 * (SQLite, or a lost connection to Postgres), the store is read again every second.
 */
async function streamEvents(req: IncomingMessage, res: ServerResponse, task: Task, after: number, { store, scheduler, heartbeatMs }: Context): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
  let last = after;
  let ended = false;
  const send = (seq: number, event: object) => {
    if (seq <= last || ended || res.destroyed) return;
    last = seq;
    res.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const end = (status: TaskStatus) => {
    if (ended) return;
    ended = true;
    cleanup();
    res.end(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
  };
  // Sends what is stored after the last event sent, and ends the stream if the task has ended. The status
  // is read first: once a task has ended, all its events are stored. One read at a time, in order.
  let reading = Promise.resolve();
  const pull = () => {
    reading = reading
      .then(async () => {
        if (ended || res.destroyed) return;
        const { status } = (await store.task(task.id))!;
        for (const { seq, event } of await store.events(task.id, last)) send(seq, event);
        if (FINISHED.has(status)) end(status);
      })
      .catch((err: unknown) => console.error(`jig service: couldn't read ${task.id}'s events:`, err));
  };
  // The next event as it comes goes at once; one after a gap, or the end, sends what is stored first.
  const follow = (update: Update) => ("event" in update && update.event.seq === last + 1 ? send(update.event.seq, update.event) : pull());
  const changed = (id: string, seq?: unknown) => id === task.id && !(typeof seq === "number" && seq <= last) && pull();
  scheduler.updates.on(task.id, follow);
  store.changes.on("event", changed);
  store.changes.on("done", changed);
  store.changes.on("resync", pull);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
  const poll = setInterval(() => store.live || pull(), 1000);
  const cleanup = () => {
    scheduler.updates.off(task.id, follow);
    store.changes.off("event", changed);
    store.changes.off("done", changed);
    store.changes.off("resync", pull);
    clearInterval(heartbeat);
    clearInterval(poll);
  };
  res.on("close", cleanup);
  // Followed before the stored events are read, so none falls between the two.
  pull();
  await reading;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Usage: node server/api.ts --config <file>");
  const secret = process.env.JIG_GATEWAY_SECRET;
  if (!secret) throw new Error("Set JIG_GATEWAY_SECRET, the secret the gateway checks tasks' tokens with.");
  const config: Config = JSON.parse(readFileSync(values.config, "utf8"));
  // A Postgres URL holds a password, which belongs in a secret rather than the config.
  if (process.env.JIG_DATABASE_URL) config.database = process.env.JIG_DATABASE_URL;
  checkConfig(config);
  // Paths in the config are relative to it.
  const base = dirname(resolve(values.config));
  if (config.database !== ":memory:" && !/^postgres(ql)?:\/\//.test(config.database)) config.database = resolve(base, config.database);
  config.dataDir = resolve(base, config.dataDir);
  const service = await startService(config, { secret });
  console.error(`jig service listening on ${service.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      console.error("jig service: stopping the runs and exiting");
      void service.close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
