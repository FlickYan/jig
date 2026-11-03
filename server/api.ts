import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Runner, workspaceProblem } from "./runner.ts";
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
}

export interface Config {
  host?: string;
  port?: number;
  /** The SQLite file. */
  database: string;
  /** Where each task's folder goes. */
  dataDir: string;
  /** Tasks that may run at once, across tenants. */
  concurrency?: number;
  /** The model a task gets if it names none. */
  model?: string;
  gatewayBaseUrl: string;
  graceSeconds?: number;
  jig?: string[];
  gitProtocols?: string[];
  maxBodyBytes?: number;
  heartbeatSeconds?: number;
  tenants: TenantConfig[];
}

const DEFAULT_LIMITS: Limits = { concurrency: 2, maxSteps: 50, timeLimit: 1800, budgetUsd: null };
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
 * Opens the store, puts the config's tenants in it, ends what a crash left running, and listens. The
 * runner is the local one unless one is given (a test's).
 */
export async function startService(config: Config, { secret, runner }: { secret: string; runner?: Runner }): Promise<Service> {
  const store = openStore(config.database);
  for (const tenant of config.tenants) {
    const limits: Limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(tenant).filter(([key]) => key in DEFAULT_LIMITS)) };
    await store.putTenant({ id: tenant.id, limits }, tenant.keys.map((key) => key.toLowerCase()));
  }
  runner ??= new LocalRunner({
    dataDir: config.dataDir,
    jig: config.jig ?? [process.execPath, join(import.meta.dirname, "..", "src", "cli.ts")],
    gatewayBaseUrl: config.gatewayBaseUrl,
    gatewaySecret: secret,
    graceSeconds: config.graceSeconds ?? 30,
    gitProtocols: config.gitProtocols,
  });
  const scheduler = new Scheduler(store, runner, config.concurrency ?? 4);
  const recovered = await scheduler.recover();
  if (recovered.length) console.error(`jig service: ${recovered.length} task(s) left running by the last run of the service marked as errors`);
  const server = createServer((req, res) => {
    handle(req, res, { store, scheduler, model: config.model ?? "deepseek-flash", maxBody: config.maxBodyBytes ?? 1024 * 1024, heartbeatMs: (config.heartbeatSeconds ?? 15) * 1000 }).catch((err) => {
      if (!res.headersSent) reply(res, 500, { error: "Internal error" });
      else res.end();
      console.error(err);
    });
  });
  await new Promise<void>((done) => server.listen(config.port ?? 8080, config.host ?? "127.0.0.1", done));
  void scheduler.poke();
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
    const tasks = await context.store.tasks(tenant.id, { status: status as TaskStatus | undefined });
    return reply(res, 200, { tasks: tasks.map((task) => view(task, false)) });
  }
  const match = /^\/v1\/tasks\/([\w-]+)(\/cancel|\/events)?$/.exec(url.pathname);
  // Another tenant's task is as missing as one that never was.
  const task = match && (await context.store.task(match[1]));
  if (!match || !task || task.tenant !== tenant.id) return reply(res, 404, { error: "No such task" });
  const [, , action] = match;
  if (!action) return req.method === "GET" ? reply(res, 200, view(task, true)) : reply(res, 405, { error: "Use GET" });
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

/** A task as the API shows it; the list leaves out the stats. */
function view(task: Task, full: boolean) {
  const { spec, tenant, stats, ...rest } = task;
  return { ...rest, prompt: spec.prompt, model: spec.model, maxSteps: spec.maxSteps, timeLimit: spec.timeLimit, ...(full && { stats }) };
}

function reply(res: ServerResponse, status: number, body: object, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(`${JSON.stringify(body)}\n`);
}

/**
 * The task's events after `after` as server-sent events (each one's id its seq): those stored, then the
 * live ones, then `event: done` with the status it ended in, and the stream ends. A client that reconnects
 * with Last-Event-ID gets only what came after.
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
  // Followed before the stored events are read, so none falls between the two; held until those are sent.
  let held: Update[] | undefined = [];
  const follow = (update: Update) => {
    if (held) held.push(update);
    else if ("event" in update) send(update.event.seq, update.event);
    else end(update.done);
  };
  scheduler.updates.on(task.id, follow);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs);
  const cleanup = () => {
    scheduler.updates.off(task.id, follow);
    clearInterval(heartbeat);
  };
  res.on("close", cleanup);
  for (const { seq, event } of await store.events(task.id, after)) send(seq, event);
  const now = (await store.task(task.id))!;
  const updates = held;
  held = undefined;
  for (const update of updates) follow(update);
  if (FINISHED.has(now.status)) end(now.status);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Usage: node server/api.ts --config <file>");
  const secret = process.env.JIG_GATEWAY_SECRET;
  if (!secret) throw new Error("Set JIG_GATEWAY_SECRET, the secret the gateway checks tasks' tokens with.");
  const config: Config = JSON.parse(readFileSync(values.config, "utf8"));
  // Paths in the config are relative to it.
  const base = dirname(resolve(values.config));
  config.database = config.database === ":memory:" ? config.database : resolve(base, config.database);
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
