import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sandboxProblem } from "../src/sandbox.ts";
import { Answers, APPROVAL_MODES, handleInternal, type Webhook, Webhooks } from "./approvals.ts";
import { createLog, type Log } from "./log.ts";
import { checkedGit, type Runner, workspaceProblem } from "./runner.ts";
import { DockerRunner, type DockerRunnerConfig } from "./runners/docker.ts";
import { KubernetesRunner, type KubernetesRunnerConfig } from "./runners/k8s.ts";
import { LocalRunner } from "./runners/local.ts";
import { Scheduler, type Update } from "./scheduler.ts";
import { routeOf, type ServiceMetrics, serviceMetrics } from "./service-metrics.ts";
import {
  type Approval,
  type Counts,
  type Decision,
  FINISHED,
  isoDay,
  openStore,
  periods,
  type Quotas,
  roundUsd,
  STATUSES,
  type Store,
  type Limits,
  type Task,
  type TaskSpec,
  type TaskStatus,
  type Tenant,
  type UsageQuery,
  type UsageRow,
} from "./store.ts";

// The task service's HTTP API (docs/server.md): tenants create tasks, follow their events, answer the
// approvals they ask for and cancel them, each with its own API key, and sees only its own tasks. A second
// listener, which only tasks reach, is where their jig waits for those answers (approvals.ts), and a third,
// if the config asks for it, serves the metrics (service-metrics.ts) to Prometheus.
// `node server/api.ts --config <file>` runs it.

export interface TenantConfig {
  id: string;
  /** SHA-256 hashes of the tenant's API keys, in hex: the config holds no key itself. */
  keys: string[];
  concurrency?: number;
  maxSteps?: number;
  timeLimit?: number;
  budgetUsd?: number | null;
  maxQueued?: number;
  /** Seconds a task with approvals waits for an answer before it takes a deny. */
  approvalTimeout?: number;
  /** Where each approval its tasks ask for is POSTed, signed with the secret in the variable webhookSecretEnv names. */
  approvalWebhook?: string;
  webhookSecretEnv?: string;
  /** The most tasks it may create in a UTC day, and USD its tasks may spend in a UTC day or month. */
  quotas?: Quotas;
}

export interface Config {
  /** The region this service is (router.ts): its tasks' ids carry it. */
  region?: string;
  host?: string;
  port?: number;
  /** The listener only tasks reach, where their jig waits for approvals' answers (default 127.0.0.1:8082). */
  internal?: { host?: string; port?: number };
  /** The internal listener's address as the tasks reach it (default: http://<internal host>:<port>). */
  internalBaseUrl?: string;
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
  /** The hosts a workspace may be cloned from (default: any). */
  gitHosts?: string[];
  /** The local runner's: what else its tasks' commands can't read, as absolute paths. */
  local?: { hiddenPaths?: string[] };
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
  /** The most bytes of a task's events (as JSON) that are stored. */
  maxEventBytes?: number;
  /** Keep each task's folder after it ends. */
  keepTaskDirs?: boolean;
  /** The environment variable that holds the key to /admin/usage; without it, /admin is 404. */
  adminKeyEnv?: string;
  /** The listener that serves GET /metrics and GET /healthz, and nothing else (none without it; host 127.0.0.1 by default). */
  metrics?: { host?: string; port: number };
  tenants: TenantConfig[];
}

/** What every runner takes from the config's top level, and the service's log. */
type Shared = "dataDir" | "gatewayBaseUrl" | "gatewaySecret" | "graceSeconds" | "gitProtocols" | "internalBaseUrl" | "log";

const DEFAULT_LIMITS: Required<Limits> = { concurrency: 2, maxSteps: 50, timeLimit: 1800, budgetUsd: null, maxQueued: 1000, approvalTimeout: 600, quotas: {} };
/** The longest time limit or approval timeout, in seconds: under jig's 24 days, and a timer's 2^31 ms. */
const MAX_SECONDS = 2_000_000;
const MAX_PROMPT = 100_000;
const MAX_FILES = 1_000;
/** How long what the metrics read from the store is used for, however many scrape meanwhile. */
const COUNTS_MS = 5_000;
/** A client's x-request-id that is used as it is; any other gets one of the service's own. */
const REQUEST_ID = /^[\w.-]{1,128}$/;

export interface Service {
  url: string;
  /** The internal listener's address, as this replica listens on it. */
  internalUrl: string;
  /** The metrics listener's address, if the config asks for one. */
  metricsUrl?: string;
  metrics: ServiceMetrics;
  server: Server;
  store: Store;
  scheduler: Scheduler;
  close(): Promise<void>;
}

/** A request as the service logs it: its id, and its tenant once it is known. */
interface ServedRequest {
  id: string;
  log: Log;
  tenant?: string;
}

/**
 * Checks the config, opens the store, puts the config's tenants in it and shuts out those it no longer
 * lists, listens, on the internal and metrics listeners too, and only then ends the tasks of replicas that
 * are gone and starts what is queued.
 * The runner is the local one unless one is given (a test's); `webhookRetryMs` is the pause before a
 * webhook's first retry; `now` is the clock the quotas' days and months, the tasks' creation times they
 * count, and the usage report's default range, are read from; `log` is where its lines go (createLog's, by
 * default); `countsMs`, how long the metrics' reads of the store are used for; `configFile`, the config's
 * path, which the local runner hides from its tasks' commands.
 */
export async function startService(
  config: Config,
  {
    secret,
    runner,
    webhookRetryMs,
    now = () => new Date(),
    log = createLog("service"),
    countsMs = COUNTS_MS,
    configFile,
  }: { secret: string; runner?: Runner; webhookRetryMs?: number; now?: () => Date; log?: Log; countsMs?: number; configFile?: string },
): Promise<Service> {
  checkConfig(config);
  const adminKey = config.adminKeyEnv === undefined ? undefined : process.env[config.adminKeyEnv];
  if (config.adminKeyEnv !== undefined && !adminKey) throw new Error(`Set ${config.adminKeyEnv}, the key to the service's /admin routes.`);
  // A Bearer is read up to the first whitespace, so a key with some could never be given.
  if (adminKey && /\s/.test(adminKey)) throw new Error(`${config.adminKeyEnv} holds whitespace (a trailing newline?): the admin key can't hold any`);
  const webhooks = new Webhooks(webhooksOf(config.tenants), webhookRetryMs, log);
  const store = await openStore(config.database, { region: config.region });
  const answers = new Answers(store);
  const metrics = serviceMetrics();
  /**
   * Serves a listener's requests, each answered with its x-request-id and logged at debug once it is over,
   * and on the API's listener (`api`) counted by its route. One that fails is a 500, and logged.
   */
  const handler =
    (serve: (req: IncomingMessage, res: ServerResponse, request: ServedRequest) => Promise<void>, api = false) =>
    (req: IncomingMessage, res: ServerResponse) => {
      const began = performance.now();
      const given = req.headers["x-request-id"];
      const id = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
      res.setHeader("x-request-id", id);
      const request: ServedRequest = { id, log: log.with({ request: id }) };
      const path = URL.parse(req.url ?? "/", "http://service")?.pathname ?? "/";
      res.once("close", () => {
        const seconds = (performance.now() - began) / 1000;
        const route = routeOf(path);
        if (api) {
          metrics.httpRequests.inc({ route, status: res.statusCode });
          metrics.httpSeconds.observe({ route }, seconds);
        }
        request.log.debug("request", { method: req.method, path, status: res.statusCode, ms: Math.round(seconds * 1000), tenant: request.tenant });
      });
      void serve(req, res, request).catch((err) => {
        if (!res.headersSent) reply(res, 500, { error: "Internal error" });
        else res.end();
        request.log.error("request failed", { err, tenant: request.tenant });
      });
    };
  // A warm worker's claim is its runner's to answer (pool.ts); the rest are approvals.
  const internal = createServer(
    handler((req, res) => (runner?.claim && req.url?.split("?")[0] === "/internal/pool/claim" ? runner.claim(req, res) : handleInternal(req, res, { store, answers, secret }))),
  );
  // Prometheus's, apart from the API and from what the tasks reach.
  const metricsServer =
    config.metrics &&
    createServer(
      handler(async (req, res) => {
        const path = URL.parse(req.url ?? "/", "http://service")?.pathname;
        if (req.method === "GET" && path === "/metrics") return metrics.registry.serve(res);
        if (req.method === "GET" && path === "/healthz") return reply(res, 200, { ok: true });
        reply(res, 404, { error: "Not found: this listener serves GET /metrics and GET /healthz" });
      }),
    );
  // The API listens before the scheduler starts, so a port that is taken stops the start before any task is
  // claimed; a request that comes in meanwhile waits for the scheduler.
  let started!: (context: Context) => void;
  let failed!: (err: unknown) => void;
  const ready = new Promise<Context>((done, fail) => ((started = done), (failed = fail)));
  ready.catch(() => {});
  const server = createServer(handler(async (req, res, request) => handle(req, res, await ready, request), true));
  let scheduler: Scheduler | undefined;
  const close = async () => {
    // No task is claimed from here on: one posted while the runner closes stays queued, rather than start
    // cold and be stopped as an error.
    scheduler?.pause();
    webhooks.close();
    // The idle workers first, their claims answered while the internal listener is still up.
    await runner?.close?.();
    const listeners = [server, internal, ...(metricsServer ? [metricsServer] : [])].filter((listener) => listener.listening);
    for (const listener of listeners) listener.closeAllConnections();
    await Promise.all(listeners.map((listener) => new Promise((done) => listener.close(done))));
    await answers.close();
    await scheduler?.close();
    await store.close();
  };
  let url: string;
  let internalUrl: string;
  let metricsUrl: string | undefined;
  try {
    for (const tenant of config.tenants) {
      const limits: Limits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(tenant).filter(([key]) => key in DEFAULT_LIMITS)) };
      await store.putTenant({ id: tenant.id, limits }, tenant.keys.map((key) => key.toLowerCase()));
    }
    // A tenant taken out of the config is revoked: its keys stop working and what it queued won't run.
    const retired = await store.retireTenants(config.tenants.map((tenant) => tenant.id));
    if (retired) log.warn(`${retired} queued task(s) of tenants no longer in the config cancelled`);
    // Before any task starts, as their jig asks for approvals there.
    internalUrl = await listen(internal, config.internal?.port ?? 8082, config.internal?.host ?? "127.0.0.1");
    url = await listen(server, config.port ?? 8080, config.host ?? "127.0.0.1");
    if (metricsServer) metricsUrl = await listen(metricsServer, config.metrics!.port, config.metrics!.host ?? "127.0.0.1");
    // What the local runner hides beside dataDir that holds more than the service's own files.
    const folders = !runner && (config.runner ?? "local") === "local" ? hiddenFolders(config.dataDir, configFile) : [];
    runner ??= runnerFor(config, secret, config.internalBaseUrl ?? internalUrl, log, folders);
    runner.warm?.(config.internalBaseUrl ?? internalUrl);
    if (runner instanceof LocalRunner) for (const warning of localRisks(config, folders)) log.warn(warning);
    // The Kubernetes runner's clone is in the task's pod, on its network.
    if (!config.gitHosts && (runner instanceof LocalRunner || runner instanceof DockerRunner)) {
      log.warn(`a ${runner instanceof LocalRunner ? "local" : "docker"} task's workspace.git is cloned by the service, on this machine's network, from any host a tenant names: list the hosts it may clone from in gitHosts`);
    }
    const { concurrency = 4, replicaId, leaseSeconds = 30, maxEvents, maxEventBytes, keepTaskDirs, gitHosts } = config;
    const onApproval = (task: Task, approval: Approval) => webhooks.send(task, approval);
    scheduler = new Scheduler(store, runner, { concurrency, replicaId, leaseMs: leaseSeconds * 1000, maxEvents, maxEventBytes, keepTaskDirs, gitHosts, onApproval, metrics, log });
    const expired = await scheduler.start();
    if (expired.length) log.warn(`${expired.length} task(s) whose replica is gone (a crash, or a kill) marked as errors`);
  } catch (err) {
    // Its port is taken, say: what has started stops.
    failed(err);
    await close();
    throw err;
  }
  collect(metrics, { store, runner, tenants: config.tenants.map((tenant) => tenant.id), countsMs });
  started({
    store,
    scheduler,
    answers,
    region: config.region ?? null,
    model: config.model ?? "deepseek-flash",
    gitHosts: config.gitHosts,
    maxBody: config.maxBodyBytes ?? 1024 * 1024,
    heartbeatMs: (config.heartbeatSeconds ?? 15) * 1000,
    adminKey: adminKey === undefined ? undefined : sha256(adminKey),
    now,
    metrics,
  });
  return { url, internalUrl, metricsUrl, metrics, server, store, scheduler, close };
}

/**
 * What the local runner's tasks could still do to the service or to each other. jig's sandbox hides dataDir
 * from their commands, but for the task's own project and home, and the database and the config's folder
 * (see runners/local.ts); without one, they run directly on the machine. With one, they share its kernel,
 * /tmp and /var/tmp (each task has a TMPDIR of its own), and on macOS its processes and localhost; they read
 * whatever else the service's user can, and connect to the Unix sockets there, which a read-only file
 * system doesn't stop. And with dataDir in one of those, which they can write, a task's commands can change
 * its home there, whose git config jig's own git reads, outside the sandbox. A hidden folder (`folders`)
 * that is the machine's root, /etc, /usr or the service user's home hides what their commands need.
 */
function localRisks(config: Config, folders: HiddenFolder[]): string[] {
  // The temp folders jig's sandbox lets commands write, as sandbox.ts's createSandbox has them, but the
  // task's own TMPDIR: not the service's.
  const temps = (process.platform === "darwin" ? ["/tmp", "/private/tmp"] : ["/tmp", "/var/tmp"]).flatMap((dir) => [dir, realOrSame(dir)]);
  const inTemp = (path: string) =>
    temps.some((dir) => {
      const rel = relative(dir, resolve(path));
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    });
  const problem = sandboxProblem();
  if (problem) return [`jig has no sandbox here (${problem}), so a local task's commands run directly on this machine: they can read and write the other tasks' folders, the database and the config (the docker and kubernetes runners keep them apart)`];
  return [
    "a local task's commands can read whatever the service's user can, but for dataDir, the database's files, the config's folder and local.hiddenPaths, and connect to the Unix sockets on this machine (Docker's, a local Postgres's or Redis's, an ssh-agent's): run the service as a user of its own, with no more than it needs",
    ...folders.flatMap(({ what, path }) => {
      const real = realOrSame(path);
      const home = realOrSame(homedir());
      if (real !== home && !["/", "/etc", "/usr"].some((dir) => real === realOrSame(dir))) return [];
      const fix = what === "the config's folder" ? "keep the config in a folder of its own" : "keep dataDir out of that checkout";
      return [`the local runner hides ${what}, ${path}, from its tasks' commands, and that is ${real === home ? "the service user's home directory, where the toolchains they use may be" : "a folder every task's commands need"}: ${fix}`];
    }),
    ...(config.tenants.length > 1 ? [`the local runner keeps tenants apart only by jig's sandbox: a task's commands can't read the database's files or the other tasks' folders, but share the machine's kernel, /tmp and /var/tmp, and on macOS its processes and localhost${process.platform === "darwin" ? ", so they can read the service's own environment, its secrets included" : ""} (the docker and kubernetes runners keep them apart)`] : []),
    ...(inTemp(config.dataDir) ? ["dataDir is in a temp folder, where a local task's commands can write their task's home, whose git config jig's own git reads outside the sandbox: keep it elsewhere"] : []),
  ];
}

/** Whether the config's database is a SQLite file. */
function sqliteFile(database: string): boolean {
  return database !== ":memory:" && !/^postgres(ql)?:\/\//.test(database);
}

/** The path with its links resolved, or as it is if it isn't there. */
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Sets the gauges that are read at a scrape: the tasks queued and running, the approvals waiting and the
 * replicas up, from the store, and the pool's idle workers, from the runner. The store's are read at most
 * every `countsMs`, however many scrape, and are its whole: on Postgres, every replica's alike.
 */
function collect(metrics: ServiceMetrics, { store, runner, tenants, countsMs }: { store: Store; runner: Runner; tenants: string[]; countsMs: number }): void {
  let read: { at: number; counts: Promise<Counts> } | undefined;
  const counts = () => {
    if (read && Date.now() - read.at < countsMs) return read.counts;
    const reading = store.counts();
    read = { at: Date.now(), counts: reading };
    // A failed read is tried again at the next scrape; meanwhile the gauges stay as they were.
    reading.catch(() => {
      metrics.storeErrors.inc();
      if (read?.counts === reading) read = undefined;
    });
    return reading;
  };
  metrics.tasks.onCollect(async () => {
    const { tasks } = await counts();
    metrics.tasks.reset();
    // The config's tenants show 0 rather than nothing, so a graph of them doesn't break off.
    for (const tenant of tenants) for (const status of ["queued", "running"]) metrics.tasks.set({ tenant, status }, 0);
    for (const { tenant, status, count } of tasks) metrics.tasks.set({ tenant, status }, count);
  });
  metrics.oldestQueued.onCollect(async () => {
    const { tasks } = await counts();
    metrics.oldestQueued.reset();
    for (const { tenant, status, oldest } of tasks) if (status === "queued") metrics.oldestQueued.set({ tenant }, Math.max(0, Date.now() - Date.parse(oldest)) / 1000);
  });
  metrics.approvalsPending.onCollect(async () => metrics.approvalsPending.set({}, (await counts()).pendingApprovals));
  metrics.replicas.onCollect(async () => metrics.replicas.set({}, (await counts()).replicas));
  metrics.poolIdle.onCollect(() => {
    if (runner.pool) metrics.poolIdle.set({}, runner.pool.stats().idle);
  });
}

/** Listens, and gives the address it listens on as a URL. */
async function listen(server: Server, port: number, host: string): Promise<string> {
  await new Promise<void>((done, fail) => server.once("error", fail).listen(port, host, () => (server.off("error", fail), done())));
  const { address, port: bound } = server.address() as AddressInfo;
  return `http://${address.includes(":") ? `[${address}]` : address}:${bound}`;
}

/** The tenants' approval webhooks, each with its secret from the environment. */
function webhooksOf(tenants: TenantConfig[]): Map<string, Webhook> {
  const hooks = new Map<string, Webhook>();
  for (const { id, approvalWebhook, webhookSecretEnv } of tenants) {
    if (!approvalWebhook || !webhookSecretEnv) continue;
    const secret = process.env[webhookSecretEnv];
    if (!secret) throw new Error(`Set ${webhookSecretEnv}, the secret tenant ${id}'s approval webhook is signed with.`);
    hooks.set(id, { url: approvalWebhook, secret });
  }
  return hooks;
}

/**
 * The runner the config names, its lines (and its pool's) in the service's `log`. The local runner's tasks'
 * commands can't read, beside dataDir, the SQLite database's files, `folders` (hiddenFolders') and what the
 * config's local.hiddenPaths list.
 */
function runnerFor(config: Config, secret: string, internalBaseUrl: string, log: Log, folders: HiddenFolder[]): Runner {
  const shared = { dataDir: config.dataDir, gatewayBaseUrl: config.gatewayBaseUrl, gatewaySecret: secret, graceSeconds: config.graceSeconds ?? 30, gitProtocols: config.gitProtocols, internalBaseUrl, log };
  const { runner = "local", docker, kubernetes } = config;
  if (runner === "local") {
    const database = sqliteFile(config.database) ? ["", "-wal", "-shm", "-journal"].map((end) => config.database + end) : [];
    const hidden = [...new Set([...database, ...folders.map(({ path }) => path), ...(config.local?.hiddenPaths ?? [])])];
    return new LocalRunner({ ...shared, hidden, jig: config.jig ?? [process.execPath, join(import.meta.dirname, "..", "src", "cli.ts")] });
  }
  if (runner === "docker" && docker?.image && docker.network) return new DockerRunner({ ...docker, ...shared });
  if (runner === "docker") throw new Error('The docker runner needs "docker": {"image", "network"}: the worker image, and an internal network the gateway is on');
  if (runner === "kubernetes" && kubernetes?.image) return new KubernetesRunner({ ...kubernetes, ...shared });
  if (runner === "kubernetes") throw new Error('The kubernetes runner needs "kubernetes": {"image"}: the worker image');
  throw new Error(`runner must be local, docker or kubernetes, not ${JSON.stringify(runner)}`);
}

/** A folder the local runner hides that holds more than the service's own files, and what it is. */
interface HiddenFolder {
  what: string;
  path: string;
}

/**
 * The folders the local runner hides beside dataDir and the database: the one the config (`configFile`) is
 * in, where the service's other secrets are kept too, and the git checkouts dataDir is in (the service run
 * from one, say), as git finds them once at the start: its own, and that one's superproject, if it is a
 * submodule, or main checkout, if it is a worktree. GIT_CEILING_DIRECTORIES keeps a task's git out of them,
 * but not its commands' reads: their files, a deploy's .env among them, are the service's. Whoever owns
 * them: git would otherwise refuse another user's checkout, which would stay readable.
 */
function hiddenFolders(dataDir: string, configFile: string | undefined): HiddenFolder[] {
  const folders = configFile ? [{ what: "the config's folder", path: dirname(resolve(configFile)) }] : [];
  try {
    mkdirSync(dataDir, { recursive: true });
    // The superproject last, as git prints nothing for it outside a submodule. The common folder comes
    // relative to dataDir unless it is elsewhere: --path-format=absolute would make it absolute, but a git
    // before 2.31 (Debian 11 has 2.30) prints it back as if it were a path.
    const args = ["-c", "safe.directory=*", "rev-parse", "--show-toplevel", "--git-common-dir", "--show-superproject-working-tree"];
    const said = execFileSync("git", args, { cwd: dataDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const [top, relativeCommon, superproject] = said.split("\n");
    const common = relativeCommon && realpathSync(resolve(realpathSync(dataDir), relativeCommon));
    if (top) folders.push({ what: "the git checkout dataDir is in", path: top });
    // A checkout's own common folder is its .git; a worktree's, its main checkout's; a submodule's, in its
    // superproject's .git/modules, so not a checkout's .git.
    if (common && basename(common) === ".git" && dirname(common) !== top) folders.push({ what: "the main checkout of the worktree dataDir is in", path: dirname(common) });
    if (superproject) folders.push({ what: "the superproject of the checkout dataDir is in", path: superproject });
  } catch {
    // Not in one, or no git.
  }
  return folders;
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
  const positive = (name: string, value: unknown, zero = false, most = Infinity) =>
    value === undefined || (typeof value === "number" && Number.isFinite(value) && (zero ? value >= 0 : value > 0) && value <= most) ? undefined : `${name} must be a number over ${zero ? "or at " : ""}0${most < Infinity ? `, up to ${most}` : ""}, not ${JSON.stringify(value)}`;
  const strings = (name: string, value: unknown) =>
    value === undefined || (Array.isArray(value) && value.length && value.every((item) => typeof item === "string" && item)) ? undefined : `${name} must be a list of strings`;
  const http = (name: string, value: unknown) =>
    value === undefined || (typeof value === "string" && /^https?:\/\//i.test(value) && URL.canParse(value)) ? undefined : `${name} must be an http or https URL, not ${JSON.stringify(value)}`;
  const poolProblem = (block: string, pool: unknown) =>
    pool === undefined ? undefined
    : !isObject(pool) ? `${block}.pool must be an object, {size, maxIdleSeconds}`
    : (whole(`${block}.pool.size`, pool.size, 0) ??
      // A replica runs at most concurrency tasks at once, and a typo would start thousands of workers.
      ((pool.size as number) > (config.concurrency ?? 4) ? `${block}.pool.size must be at most concurrency, ${config.concurrency ?? 4}: idle workers past it are never used` : undefined) ??
      positive(`${block}.pool.maxIdleSeconds`, pool.maxIdleSeconds) ??
      http(`${block}.pool.baseUrl`, pool.baseUrl));
  // Only an absent runner is the local one: null is a wrong value, as it is for every other field.
  const runner = config.runner === undefined ? "local" : config.runner;
  const problem =
    (config.region === undefined || (typeof config.region === "string" && /^[a-z0-9]{1,16}$/.test(config.region)) ? undefined : `region must be 1 to 16 lowercase letters and digits, not ${JSON.stringify(config.region)}`) ??
    text("database", config.database, true) ??
    text("dataDir", config.dataDir, true) ??
    text("gatewayBaseUrl", config.gatewayBaseUrl, true) ??
    http("gatewayBaseUrl", config.gatewayBaseUrl) ??
    text("host", config.host, false) ??
    whole("port", config.port, 0, 65535) ??
    (config.internal === undefined || isObject(config.internal) ? undefined : "internal must be an object, {host, port}") ??
    text("internal.host", config.internal?.host, false) ??
    whole("internal.port", config.internal?.port, 0, 65535) ??
    http("internalBaseUrl", config.internalBaseUrl) ??
    whole("concurrency", config.concurrency, 1) ??
    text("model", config.model, false) ??
    // A time limit and its grace stay under a timer's 2^31 ms, past which it fires at once.
    positive("graceSeconds", config.graceSeconds, true, 86_400) ??
    strings("jig", config.jig) ??
    strings("gitProtocols", config.gitProtocols) ??
    strings("gitHosts", config.gitHosts) ??
    (config.local === undefined || isObject(config.local) ? undefined : "local must be an object, {hiddenPaths}") ??
    (config.local?.hiddenPaths === undefined || (Array.isArray(config.local.hiddenPaths) && config.local.hiddenPaths.every((path) => typeof path === "string" && isAbsolute(path)))
      ? undefined
      : `local.hiddenPaths must be a list of absolute paths, not ${JSON.stringify(config.local.hiddenPaths)}`) ??
    whole("maxBodyBytes", config.maxBodyBytes, 1) ??
    positive("heartbeatSeconds", config.heartbeatSeconds, false, 3_600) ??
    text("replicaId", config.replicaId, false) ??
    positive("leaseSeconds", config.leaseSeconds, false, 86_400) ??
    whole("maxEvents", config.maxEvents, 1) ??
    whole("maxEventBytes", config.maxEventBytes, 1) ??
    // Checked here, so a runner that can't start is refused before the store is changed.
    (["local", "docker", "kubernetes"].includes(runner) ? undefined : `runner must be local, docker or kubernetes, not ${JSON.stringify(runner)}`) ??
    (runner === "docker" ? (text("docker.image", config.docker?.image, true) ?? text("docker.network", config.docker?.network, true)) : undefined) ??
    (runner === "kubernetes" ? text("kubernetes.image", config.kubernetes?.image, true) : undefined) ??
    poolProblem("docker", config.docker?.pool) ??
    poolProblem("kubernetes", config.kubernetes?.pool) ??
    (fields.keepTaskDirs === undefined || typeof fields.keepTaskDirs === "boolean" ? undefined : "keepTaskDirs must be true or false") ??
    text("adminKeyEnv", config.adminKeyEnv, false) ??
    (config.metrics === undefined || isObject(config.metrics) ? undefined : "metrics must be an object, {host, port}") ??
    text("metrics.host", config.metrics?.host, false) ??
    (config.metrics && config.metrics.port === undefined ? "metrics.port is missing" : undefined) ??
    whole("metrics.port", config.metrics?.port, 0, 65535) ??
    (Array.isArray(config.tenants) ? undefined : "tenants must be a list");
  if (problem) return problem;
  const tenants = new Set<string>();
  /** Which tenant each key opens: one key may open only one. */
  const owners = new Map<string, string>();
  for (const [i, tenant] of config.tenants.entries()) {
    const at = `tenants[${i}]`;
    if (!isObject(tenant)) return `${at} must be an object`;
    const notQuota = isObject(tenant.quotas) ? Object.keys(tenant.quotas).find((key) => !["tasksPerDay", "usdPerDay", "usdPerMonth"].includes(key)) : undefined;
    const problem =
      text(`${at}.id`, tenant.id, true) ??
      (tenants.has(tenant.id) ? `${at}.id ${JSON.stringify(tenant.id)} is another tenant's too` : undefined) ??
      (Array.isArray(tenant.keys) ? undefined : `${at}.keys must be a list of the SHA-256 hashes of its API keys, in hex`) ??
      whole(`${at}.concurrency`, tenant.concurrency, 0) ??
      whole(`${at}.maxSteps`, tenant.maxSteps, 1) ??
      whole(`${at}.timeLimit`, tenant.timeLimit, 1, MAX_SECONDS) ??
      (tenant.budgetUsd === null ? undefined : positive(`${at}.budgetUsd`, tenant.budgetUsd)) ??
      whole(`${at}.maxQueued`, tenant.maxQueued, 0) ??
      whole(`${at}.approvalTimeout`, tenant.approvalTimeout, 1, MAX_SECONDS) ??
      http(`${at}.approvalWebhook`, tenant.approvalWebhook) ??
      text(`${at}.webhookSecretEnv`, tenant.webhookSecretEnv, tenant.approvalWebhook !== undefined) ??
      (tenant.quotas === undefined || isObject(tenant.quotas) ? undefined : `${at}.quotas must be an object, {tasksPerDay, usdPerDay, usdPerMonth}`) ??
      (notQuota === undefined ? undefined : `${at}.quotas.${notQuota} isn't a quota: tasksPerDay, usdPerDay or usdPerMonth`) ??
      whole(`${at}.quotas.tasksPerDay`, tenant.quotas?.tasksPerDay, 1) ??
      positive(`${at}.quotas.usdPerDay`, tenant.quotas?.usdPerDay) ??
      positive(`${at}.quotas.usdPerMonth`, tenant.quotas?.usdPerMonth);
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
  answers: Answers;
  region: string | null;
  model: string;
  gitHosts?: string[];
  maxBody: number;
  heartbeatMs: number;
  /** The SHA-256 of the admin key, when there is one. */
  adminKey?: Buffer;
  now: () => Date;
  metrics: ServiceMetrics;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest();

async function handle(req: IncomingMessage, res: ServerResponse, context: Context, request: ServedRequest): Promise<void> {
  const url = new URL(req.url ?? "/", "http://service");
  if (url.pathname === "/healthz") return reply(res, 200, { ok: true, region: context.region });
  const key = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return admin(req, res, url, key, context);
  const tenant = key && (await context.store.tenantByKey(createHash("sha256").update(key).digest("hex")));
  if (!tenant) return reply(res, 401, { error: "A tenant's API key is needed: Authorization: Bearer <key>" }, { "www-authenticate": "Bearer" });
  request.tenant = tenant.id;

  if (url.pathname === "/v1/usage") return req.method === "GET" ? usage(res, url, context, { tenant: tenant.id }) : reply(res, 405, { error: "Use GET" });

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
    const pending = await context.store.pendingApprovals(tasks.map((task) => task.id));
    // A full page may have more after it: the next is read with before=<next>.
    return reply(res, 200, { tasks: tasks.map((task) => view(task, { prompt: full }, pending, context.region)), ...(tasks.length === limit && { next: tasks.at(-1)!.id }) });
  }
  const match = /^\/v1\/tasks\/([\w-]+)(\/cancel|\/events|\/approvals(?:\/([\w-]{1,100}))?)?$/.exec(url.pathname);
  // Another tenant's task is as missing as one that never was.
  const task = match && (await context.store.task(match[1]));
  if (!match || !task || task.tenant !== tenant.id) return reply(res, 404, { error: "No such task" });
  const [, , action, approval] = match;
  if (!action) return req.method === "GET" ? reply(res, 200, view(task, { prompt: true, stats: true }, await context.store.pendingApprovals([task.id]), context.region)) : reply(res, 405, { error: "Use GET" });
  if (action === "/approvals") return req.method === "GET" ? reply(res, 200, { approvals: await context.store.approvals(task.id) }) : reply(res, 405, { error: "Use GET" });
  if (approval !== undefined) return answer(req, res, task, approval, context);
  if (action === "/cancel") {
    if (req.method !== "POST") return reply(res, 405, { error: "Use POST" });
    if (FINISHED.has(task.status)) return reply(res, 409, { error: `The task has already ended: ${task.status}`, id: task.id, status: task.status });
    const status = await context.scheduler.cancel(task);
    return reply(res, status === "cancelled" ? 200 : 202, { id: task.id, status });
  }
  if (req.method !== "GET") return reply(res, 405, { error: "Use GET" });
  const after = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  if (typeof after !== "string" || !/^\d{1,9}$/.test(after)) return reply(res, 400, { error: "Last-Event-ID and after must be an event's seq" });
  return streamEvents(req, res, task, Number(after), context, request);
}

async function createTask(req: IncomingMessage, res: ServerResponse, tenant: Tenant, context: Context): Promise<void> {
  const refused = (reason: "queue" | "quota" | "invalid") => context.metrics.refused.inc({ tenant: tenant.id, reason });
  const body = await readBody(req, context.maxBody);
  if (body === undefined) {
    refused("invalid");
    res.setHeader("connection", "close");
    return reply(res, 413, { error: `The body is over ${context.maxBody} bytes` });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    refused("invalid");
    return reply(res, 400, { error: "The body isn't JSON" });
  }
  // A spec may name the region it is for, as the router reads it; the task is made only in that region.
  if (isObject(input) && input.region !== undefined) {
    const { region, ...rest } = input;
    if (typeof region !== "string" || !/^[a-z0-9]{1,16}$/.test(region)) return reply(res, 400, { error: "region must be a region's name" });
    if (region !== context.region) return reply(res, 400, { error: `this is ${context.region ? `region ${context.region}` : "a service with no region"}; post to region ${region}'s service or through the router` });
    input = rest;
  }
  const spec = taskSpec(input, tenant, context.model, context.gitHosts);
  if (typeof spec === "string") {
    refused("invalid");
    return reply(res, 400, { error: spec });
  }
  // A queue without an end would fill the disk, and a tenant's waits only grow. The caps are counted with
  // the insert, so replicas sharing the store keep to them together.
  const now = context.now();
  const task = await context.store.createTask(tenant.id, spec, { maxQueued: tenant.limits.maxQueued ?? DEFAULT_LIMITS.maxQueued, ...tenant.limits.quotas, now });
  if ("quota" in task) {
    const { quota, limit, used } = task;
    refused(quota === "maxQueued" ? "queue" : "quota");
    if (quota === "maxQueued") return reply(res, 429, { error: `The tenant has ${limit} tasks queued, the most it may: wait for some to start` });
    const { nextDay, nextMonth } = periods(now);
    const resets = quota === "usdPerMonth" ? nextMonth : nextDay;
    const what = quota === "tasksPerDay" ? `created ${used} tasks today (UTC), the most it may` : `spent $${used} ${quota === "usdPerDay" ? "today (UTC)" : "this month (UTC)"}, against a quota of $${limit}`;
    const retryAfter = String(Math.max(1, Math.ceil((resets.getTime() - now.getTime()) / 1000)));
    return reply(res, 429, { error: `The tenant has ${what}: its ${quota} quota resets at ${resets.toISOString()}`, quota, limit, used, resetsAt: resets.toISOString() }, { "retry-after": retryAfter });
  }
  context.metrics.created.inc({ tenant: tenant.id });
  void context.scheduler.poke();
  reply(res, 201, { id: task.id, status: task.status });
}

/** The /admin routes: 404 without an admin key in the config, and only GET /admin/usage, to that key. */
async function admin(req: IncomingMessage, res: ServerResponse, url: URL, key: string | undefined, context: Context): Promise<void> {
  if (!context.adminKey || url.pathname !== "/admin/usage") return reply(res, 404, { error: "Not found" });
  // Compared as hashes, which are the same length, in constant time.
  if (!key || !timingSafeEqual(sha256(key), context.adminKey)) return reply(res, 401, { error: "The admin key is needed: Authorization: Bearer <key>" }, { "www-authenticate": "Bearer" });
  if (req.method !== "GET") return reply(res, 405, { error: "Use GET" });
  const tenant = url.searchParams.get("tenant");
  if (tenant !== null && !tenant) return reply(res, 400, { error: "tenant must be a tenant's id" });
  return usage(res, url, context, { byTenant: true, ...(tenant !== null && { tenant }) }, ["tenant"]);
}

const DAY = /^(\d{4})-(\d\d)-(\d\d)$/;
const MAX_DAYS = 366;

/**
 * The usage report, ?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|model|day,model&format=json|csv: the ledger's
 * rows summed by UTC day and/or model over those days (both included; this month to today by default), at
 * most 366 of them, with their total; or the rows alone as CSV.
 */
async function usage(res: ServerResponse, url: URL, { store, now }: Context, scope: Pick<UsageQuery, "tenant" | "byTenant">, allowed: string[] = []): Promise<void> {
  const params = url.searchParams;
  const unknown = [...params.keys()].find((name) => !["from", "to", "group", "format", ...allowed].includes(name));
  if (unknown) return reply(res, 400, { error: `Unknown parameter: ${unknown}` });
  // Each is read once: tenant=a&tenant=b would otherwise report a alone.
  const twice = [...new Set(params.keys())].find((name) => params.getAll(name).length > 1);
  if (twice) return reply(res, 400, { error: `${twice} may be given once` });
  const today = now();
  const from = params.get("from") ?? isoDay(periods(today).monthStart);
  const to = params.get("to") ?? isoDay(today);
  for (const [name, day] of [["from", from], ["to", to]]) {
    const [, year, month, date] = DAY.exec(day) ?? [];
    // A day that doesn't exist (2026-02-30) comes back another from Date.
    if (!year || isoDay(new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)))) !== day || Number(year) < 1000) return reply(res, 400, { error: `${name} must be a day, YYYY-MM-DD` });
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days < 1) return reply(res, 400, { error: "from must be no later than to" });
  if (days > MAX_DAYS) return reply(res, 400, { error: `The range may be at most ${MAX_DAYS} days` });
  const group = params.get("group") ?? "day";
  if (!["day", "model", "day,model"].includes(group)) return reply(res, 400, { error: "group must be day, model or day,model" });
  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return reply(res, 400, { error: "format must be json or csv" });
  const rows = await store.usage({ from, to, group: group.split(",") as UsageQuery["group"], ...scope });
  if (format === "csv") return csv(res, rows, [...(scope.byTenant ? ["tenant"] : []), ...group.split(",")]);
  reply(res, 200, { from, to, rows, total: totalOf(rows) });
}

const SUMMED = ["tasks", "input", "output", "cacheRead", "cacheWrite", "costUsd", "seconds"] as const;

/** The rows summed: every one of them, whatever they are grouped by. */
function totalOf(rows: UsageRow[]): Omit<UsageRow, "tenant" | "day" | "model"> {
  const total = Object.fromEntries(SUMMED.map((name) => [name, rows.reduce((sum, row) => sum + row[name], 0)])) as Omit<UsageRow, "tenant" | "day" | "model">;
  // As the rows are: to the nanodollar, and the millisecond.
  return { ...total, costUsd: roundUsd(total.costUsd), seconds: Math.round(total.seconds * 1000) / 1000 };
}

/** The rows as CSV (RFC 4180): a header line, then a line each. */
function csv(res: ServerResponse, rows: UsageRow[], keys: string[]): void {
  const columns = [...keys, ...SUMMED];
  const field = (value: unknown) => {
    // Numbers in plain digits, as a spreadsheet reads them: String gives 1e-7 for a tiny cost.
    const text = typeof value === "number" && !Number.isInteger(value) ? value.toFixed(9).replace(/0+$/, "").replace(/\.$/, "") : String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [columns.join(","), ...rows.map((row) => columns.map((column) => field(row[column as keyof UsageRow])).join(","))];
  res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
  res.end(`${lines.join("\r\n")}\r\n`);
}

/**
 * A tenant's answer to an approval, {decision, always?}: 200 with the approval, 404 for one its task's jig
 * hasn't asked for (or not yet), 409 for one answered already or a task that has ended. The jig waiting for
 * it, maybe through another replica, hears it at once.
 */
async function answer(req: IncomingMessage, res: ServerResponse, task: Task, id: string, { store, answers, maxBody, metrics }: Context): Promise<void> {
  if (req.method !== "POST") return reply(res, 405, { error: "Use POST" });
  const body = await readBody(req, maxBody);
  if (body === undefined) {
    res.setHeader("connection", "close");
    return reply(res, 413, { error: `The body is over ${maxBody} bytes` });
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: "The body isn't JSON" });
  }
  if (!isObject(input)) return reply(res, 400, { error: "The body must be a JSON object" });
  const unknown = Object.keys(input).find((key) => !["decision", "always"].includes(key));
  if (unknown) return reply(res, 400, { error: `Unknown field: ${unknown}` });
  const { decision, always = false } = input;
  if (decision !== "allow" && decision !== "deny") return reply(res, 400, { error: "decision must be allow or deny" });
  if (typeof always !== "boolean") return reply(res, 400, { error: "always must be true or false" });
  const asked = await store.approval(task.id, id);
  if (!asked) return reply(res, 404, { error: "No such approval" });
  if (FINISHED.has(task.status)) return reply(res, 409, { error: `The task has already ended: ${task.status}`, approval: asked });
  const answered: Approval | undefined = asked.decision ? undefined : await store.decideApproval(task.id, id, { decision: decision as Decision, always, by: "api" });
  if (!answered) return reply(res, 409, { error: "The approval has been answered already", approval: (await store.approval(task.id, id)) ?? asked });
  answers.answered(task.id, id);
  metrics.approvalWait.observe({ decision: answered.decision! }, Math.max(0, Date.parse(answered.decidedAt!) - Date.parse(answered.requestedAt)) / 1000);
  reply(res, 200, answered);
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

/**
 * A task's spec from a request, with the tenant's limits as the defaults and the bounds; or what is wrong. A
 * repository to clone must be on one of `gitHosts`, if there are any, and is then kept as URL reads it.
 */
export function taskSpec(input: unknown, tenant: Tenant, defaultModel: string, gitHosts?: string[]): TaskSpec | string {
  if (!isObject(input)) return "The body must be a JSON object";
  const unknown = Object.keys(input).find((key) => !["prompt", "workspace", "maxSteps", "timeLimit", "model", "approvals", "mode"].includes(key));
  if (unknown) return `Unknown field: ${unknown}`;
  const { prompt, workspace, maxSteps = tenant.limits.maxSteps, timeLimit = tenant.limits.timeLimit, model = defaultModel, approvals = false, mode } = input;
  if (typeof prompt !== "string" || !prompt.trim()) return "prompt must be a string that isn't empty";
  if (prompt.length > MAX_PROMPT) return `prompt must be at most ${MAX_PROMPT} characters`;
  // Postgres text can't hold one, and jig has no use for it: refused on every store alike.
  if (prompt.includes("\0")) return "prompt must not hold a NUL character (\\u0000)";
  if (!Number.isInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > tenant.limits.maxSteps) return `maxSteps must be a whole number from 1 to ${tenant.limits.maxSteps}`;
  if (!Number.isInteger(timeLimit) || (timeLimit as number) < 1 || (timeLimit as number) > tenant.limits.timeLimit) return `timeLimit must be a whole number of seconds from 1 to ${tenant.limits.timeLimit}`;
  // The gateway serves the Anthropic API, which jig uses for Claude and DeepSeek models.
  if (typeof model !== "string" || !/^(claude|deepseek)[\w.:-]{0,100}$/.test(model)) return "model must be a Claude or DeepSeek model's id";
  if (typeof approvals !== "boolean") return "approvals must be true or false";
  // Without approvals the run asks nothing (--yes), so a mode would mean nothing.
  if (mode !== undefined && !approvals) return "mode goes with approvals: true";
  if (mode !== undefined && !APPROVAL_MODES.includes(mode as never)) return `mode must be one of: ${APPROVAL_MODES.join(", ")}`;
  const asks = approvals ? { approvals, mode: (mode ?? "edits") as TaskSpec["mode"] } : {};
  if (workspace === undefined) return { prompt, maxSteps: maxSteps as number, timeLimit: timeLimit as number, model, ...asks };
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
  // The local and Docker runners clone on the service's own network, which a tenant would otherwise reach
  // any host on. The scheduler checks it again as the task starts, should gitHosts have changed.
  const checked = typeof git === "string" ? checkedGit(git, gitHosts) : undefined;
  if (checked && "error" in checked) return checked.error;
  if (ref !== undefined && (git === undefined || typeof ref !== "string" || !/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-"))) return "workspace.ref must be a branch or tag of workspace.git";
  return { prompt, workspace: { files, git: checked?.git, ref } as TaskSpec["workspace"], maxSteps: maxSteps as number, timeLimit: timeLimit as number, model, ...asks };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A task as the API shows it, with the region it is in and how many of its approvals wait for an answer
 * (none, once it has ended); the list leaves out the stats, and the prompt unless asked.
 */
function view(task: Task, show: { prompt?: boolean; stats?: boolean }, pending: Map<string, number>, region: string | null) {
  const { spec, tenant, stats, ...rest } = task;
  const asks = { approvals: spec.approvals ?? false, ...(spec.approvals && { mode: spec.mode }), pendingApprovals: FINISHED.has(task.status) ? 0 : (pending.get(task.id) ?? 0) };
  return { ...rest, region, ...(show.prompt && { prompt: spec.prompt }), model: spec.model, maxSteps: spec.maxSteps, timeLimit: spec.timeLimit, ...asks, ...(show.stats && { stats }) };
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
async function streamEvents(req: IncomingMessage, res: ServerResponse, task: Task, after: number, { store, scheduler, heartbeatMs, metrics }: Context, request: ServedRequest): Promise<void> {
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
      .catch((err: unknown) => {
        metrics.storeErrors.inc();
        request.log.error("couldn't read the task's events", { tenant: task.tenant, task: task.id, err });
      });
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

/**
 * Makes the config's paths absolute, from `base`, the config's folder: the database's file, dataDir, and
 * those of jig's entries that start with ./ or ../ (a program's name, or an absolute path, is left alone).
 * jig is started in each task's workspace, where a relative path would lead nowhere.
 */
export function resolvePaths(config: Config, base: string): void {
  if (sqliteFile(config.database)) config.database = resolve(base, config.database);
  config.dataDir = resolve(base, config.dataDir);
  if (config.jig) config.jig = config.jig.map((entry) => (/^\.\.?\//.test(entry) ? resolve(base, entry) : entry));
}

/**
 * The URL with its host in brackets if it is an IPv6 address without them: Kubernetes gives a pod's IPv6
 * address bare, so http://$(POD_IP):8082 comes out as http://fd00::1:8082, which isn't a URL.
 */
export function bracketHost(url: string): string {
  const [, scheme, host, port, rest = ""] = /^(https?:\/\/)([0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*):(\d+)(\/.*)?$/.exec(url) ?? [];
  return host ? `${scheme}[${host}]:${port}${rest}` : url;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Usage: node server/api.ts --config <file>");
  const secret = process.env.JIG_GATEWAY_SECRET;
  if (!secret) throw new Error("Set JIG_GATEWAY_SECRET, the secret the gateway checks tasks' tokens with.");
  const config: Config = JSON.parse(readFileSync(values.config, "utf8"));
  // A Postgres URL holds a password, which belongs in a secret rather than the config.
  if (process.env.JIG_DATABASE_URL) config.database = process.env.JIG_DATABASE_URL;
  // Replicas share the config, but each one's warm workers claim at its own address (its pod's, say).
  const pool = config.runner === "docker" ? config.docker?.pool : config.runner === "kubernetes" ? config.kubernetes?.pool : undefined;
  if (isObject(pool) && process.env.JIG_POOL_BASE_URL) pool.baseUrl = bracketHost(process.env.JIG_POOL_BASE_URL);
  checkConfig(config);
  resolvePaths(config, dirname(resolve(values.config)));
  const log = createLog("service");
  const service = await startService(config, { secret, log, configFile: resolve(values.config) });
  log.info(`listening on ${service.url}`, { internal: service.internalUrl, metrics: service.metricsUrl });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info("stopping the runs and exiting");
      void service.close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    createLog("service").error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
