#!/usr/bin/env node
// The router in front of several regions, each a whole stack of its own (the task service's replicas, its
// database, gateway, Redis and runners). It keeps nothing: it maps a tenant's key to the tenant, and sends
// each request to a region by what it names: a new task to the tenant's home region (or the one its spec
// names), a task to the region in its id. A region whose /healthz fails is down; a tenant that allows it
// has its new tasks sent to another region meanwhile, but a task stays where it was made, since no task's
// data leaves its region. docs/server.md's "Several regions" describes the routes and the config.
//
//   node server/router.ts --config router.json

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLog, type Log } from "./log.ts";
import { Registry } from "./metrics.ts";

export interface RouterConfig {
  /** Where to listen (default: 127.0.0.1, port 8090). */
  listen?: { host?: string; port?: number };
  /** A listener of its own for GET /metrics and GET /healthz (default host 127.0.0.1); none without it. */
  metrics?: { host?: string; port: number };
  /** The regions, each its task service's public URL; failover takes them in this order. */
  regions: { name: string; url: string }[];
  tenants: RouterTenant[];
  /** How often each region's /healthz is asked (default 5000 ms), and how many failures in a row make it down (default 2). */
  health?: { intervalMs?: number; failures?: number };
  /** The largest new task body the router reads (default 1 MiB, the services' default; set it to the largest any region's maxBodyBytes allows). */
  maxBodyBytes?: number;
}

export interface RouterTenant {
  id: string;
  /** SHA-256 hashes of the tenant's API keys, in hex, as the regions' services have them. */
  keys: string[];
  /** The region its tasks go to unless they name another. */
  home: string;
  /** The regions its tasks may be in (default: its home alone). */
  allowed?: string[];
  /** While its home is down, new tasks that name no region go to the first allowed region that is up. */
  failover?: boolean;
}

export interface Router {
  url: string;
  /** The metrics listener's address, if there is one. */
  metricsUrl?: string;
  /** Each region's standing as the router last saw it. */
  regions(): Record<string, boolean>;
  close(): Promise<void>;
}

/** A task's id with the region it was made in: task_<region>_<32 hex digits> (store.ts's newTaskId). */
const REGIONAL_ID = /^task_([a-z0-9]{1,16})_[0-9a-f]{32}$/;
/** One made before regions, or by a service without one. */
const LEGACY_ID = /^task_[0-9a-f]{32}$/;
const REGION_NAME = /^[a-z0-9]{1,16}$/;
const REQUEST_ID = /^[\w.-]{1,128}$/;
/** A region's /healthz that takes longer has failed. */
const HEALTH_TIMEOUT_MS = 2000;
// Not forwarded either way: they describe one connection, not the request.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

interface Region {
  name: string;
  url: URL;
  up: boolean;
  /** /healthz failures in a row. */
  failures: number;
  checking: boolean;
}

interface Tenant {
  id: string;
  home: string;
  allowed: string[];
  failover: boolean;
}

/** One request through the router: what its metrics and log lines say about it. */
interface Exchange {
  req: IncomingMessage;
  res: ServerResponse;
  id: string;
  started: number;
  route: string;
  log: Log;
}

/** Throws with what is wrong if the config isn't one the router can run with. */
export function checkRouterConfig(config: RouterConfig): void {
  const problem = configProblem(config);
  if (problem) throw new Error(`The router's config's ${problem}`);
}

function configProblem(config: RouterConfig): string | undefined {
  if (!isObject(config)) return "top level must be a JSON object";
  const text = (name: string, value: unknown) => (value === undefined || (typeof value === "string" && value) ? undefined : `${name} must be a string that isn't empty`);
  const whole = (name: string, value: unknown, least: number, most = Number.MAX_SAFE_INTEGER) =>
    value === undefined || (Number.isInteger(value) && (value as number) >= least && (value as number) <= most) ? undefined : `${name} must be a whole number from ${least}${most < Number.MAX_SAFE_INTEGER ? ` to ${most}` : " up"}, not ${JSON.stringify(value)}`;
  const block = (name: string, value: unknown, shape: string) => (value === undefined || isObject(value) ? undefined : `${name} must be an object, ${shape}`);
  const problem =
    block("listen", config.listen, "{host, port}") ??
    text("listen.host", config.listen?.host) ??
    whole("listen.port", config.listen?.port, 0, 65535) ??
    block("metrics", config.metrics, "{host, port}") ??
    (config.metrics && config.metrics.port === undefined ? "metrics.port is missing" : undefined) ??
    text("metrics.host", config.metrics?.host) ??
    whole("metrics.port", config.metrics?.port, 0, 65535) ??
    block("health", config.health, "{intervalMs, failures}") ??
    whole("health.intervalMs", config.health?.intervalMs, 1) ??
    whole("health.failures", config.health?.failures, 1) ??
    whole("maxBodyBytes", config.maxBodyBytes, 1) ??
    (Array.isArray(config.regions) && config.regions.length ? undefined : "regions must be a list of {name, url}, one at least") ??
    (Array.isArray(config.tenants) ? undefined : "tenants must be a list");
  if (problem) return problem;
  const regions = new Set<string>();
  for (const [i, region] of config.regions.entries()) {
    const at = `regions[${i}]`;
    if (!isObject(region)) return `${at} must be an object, {name, url}`;
    if (typeof region.name !== "string" || !REGION_NAME.test(region.name)) return `${at}.name must be 1 to 16 lowercase letters and digits, as the region's service has it, not ${JSON.stringify(region.name)}`;
    if (regions.has(region.name)) return `${at}.name ${region.name} is another region's too`;
    if (typeof region.url !== "string" || !/^https?:\/\//i.test(region.url) || !URL.canParse(region.url)) return `${at}.url must be the region's service's http or https URL, not ${JSON.stringify(region.url)}`;
    regions.add(region.name);
  }
  const tenants = new Set<string>();
  const owners = new Map<string, string>();
  for (const [i, tenant] of config.tenants.entries()) {
    const at = `tenants[${i}]`;
    if (!isObject(tenant)) return `${at} must be an object`;
    const named = (name: string, value: unknown) => (typeof value === "string" && regions.has(value) ? undefined : `${name} must be one of the regions (${[...regions].join(", ")}), not ${JSON.stringify(value)}`);
    const problem =
      (typeof tenant.id === "string" && tenant.id ? undefined : `${at}.id must be a string that isn't empty`) ??
      (tenants.has(tenant.id) ? `${at}.id ${JSON.stringify(tenant.id)} is another tenant's too` : undefined) ??
      (Array.isArray(tenant.keys) ? undefined : `${at}.keys must be a list of the SHA-256 hashes of its API keys, in hex`) ??
      named(`${at}.home`, tenant.home) ??
      (tenant.allowed === undefined || (Array.isArray(tenant.allowed) && tenant.allowed.length) ? undefined : `${at}.allowed must be a list of regions`) ??
      tenant.allowed?.map((name, j) => named(`${at}.allowed[${j}]`, name)).find(Boolean) ??
      (tenant.allowed === undefined || tenant.allowed.includes(tenant.home) ? undefined : `${at}.allowed must hold its home, ${tenant.home}`) ??
      (tenant.failover === undefined || typeof tenant.failover === "boolean" ? undefined : `${at}.failover must be true or false`);
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

/** Checks the config, starts asking the regions' health, and listens (and on the metrics listener, if it has one). */
export async function startRouter(config: RouterConfig, { log = createLog("router") }: { log?: Log } = {}): Promise<Router> {
  checkRouterConfig(config);
  const regions = new Map<string, Region>(config.regions.map(({ name, url }) => [name, { name, url: new URL(url), up: true, failures: 0, checking: false }]));
  const order = [...regions.keys()];
  const tenants = new Map<string, Tenant>();
  for (const tenant of config.tenants) {
    const entry = { id: tenant.id, home: tenant.home, allowed: tenant.allowed ?? [tenant.home], failover: tenant.failover ?? false };
    for (const key of tenant.keys) tenants.set(key.toLowerCase(), entry);
  }
  const { intervalMs = 5000, failures: most = 2 } = config.health ?? {};
  // A new task's body is read whole to find its region, so it is held in memory: no more than a region takes.
  const maxBody = config.maxBodyBytes ?? 1024 * 1024;

  const registry = new Registry();
  const requests = registry.counter("jig_router_requests_total", "Requests the router answered, by the region that answered (empty for the router's own answers), route and status.", ["region", "route", "status"]);
  const seconds = registry.histogram("jig_router_request_seconds", "Seconds from a request to its answer's headers.", ["region", "route"]);
  const up = registry.gauge("jig_router_region_up", "Whether the region's /healthz answers (1) or has failed health.failures times in a row (0).", ["region"]);
  const failovers = registry.counter("jig_router_failovers_total", "New tasks sent to another region while their home was down.", ["from", "to"]);
  for (const name of order) up.set({ region: name }, 1);

  const standing = () => Object.fromEntries([...regions.values()].map((region) => [region.name, region.up]));

  // A region is up until its /healthz fails `most` times in a row, and up again at its first answer. One
  // that answers as another region is down too: its tasks' ids would send their reads elsewhere.
  const probes = new AbortController();
  const check = async (region: Region) => {
    if (region.checking) return;
    region.checking = true;
    let problem: string | undefined;
    try {
      const res = await fetch(new URL("healthz", withSlash(region.url)), { signal: AbortSignal.any([probes.signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]) });
      const body = (await res.json().catch(() => undefined)) as { region?: unknown } | undefined;
      if (res.status !== 200) problem = `its /healthz answered ${res.status}`;
      else if (body?.region !== region.name) problem = `its /healthz says it is region ${JSON.stringify(body?.region ?? null)}`;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    } finally {
      region.checking = false;
    }
    if (probes.signal.aborted) return;
    if (problem === undefined) {
      if (!region.up) log.info(`region ${region.name} is up again`, { region: region.name });
      region.up = true;
      region.failures = 0;
    } else if (++region.failures >= most && region.up) {
      region.up = false;
      log.warn(`region ${region.name} is down: ${region.failures} health checks failed in a row`, { region: region.name, err: problem });
    }
    up.set({ region: region.name }, region.up ? 1 : 0);
  };
  const checkAll = () => {
    for (const region of regions.values()) void check(region);
  };
  const timer = setInterval(checkAll, intervalMs);
  checkAll();

  const head = (x: Exchange, status: number, headers: Record<string, string | string[] | undefined>, answered?: string) => {
    x.res.writeHead(status, { ...headers, "x-request-id": x.id, ...(answered && { "x-jig-region": answered }) });
    // Several regions' answers added up (usage's region=all) are counted as "all".
    const region = answered?.includes(",") ? "all" : (answered ?? "");
    requests.inc({ region, route: x.route, status });
    seconds.observe({ region, route: x.route }, (performance.now() - x.started) / 1000);
    x.log.debug(`${x.req.method} ${x.req.url?.split("?")[0]} ${status}`, { region: answered });
  };
  const reply = (x: Exchange, status: number, body: object, headers: Record<string, string> = {}, answered?: string) => {
    head(x, status, { "content-type": "application/json", ...headers }, answered);
    x.res.end(`${JSON.stringify(body)}\n`);
  };
  const down = (x: Exchange, region: string, what: string) =>
    reply(x, 503, { error: `Region ${region} is down: ${what}`, region }, { "retry-after": String(Math.max(1, Math.ceil(intervalMs / 1000))) });

  /**
   * Sends the request on to the region and its answer back as it comes, a stream of events included; a
   * client that goes away takes the request to the region with it. `body` is sent in place of the
   * request's own, which is otherwise passed on as it is read.
   */
  const forward = (x: Exchange, region: Region, path: string, body?: Buffer): Promise<void> =>
    new Promise((done) => {
      const headers = Object.fromEntries(Object.entries(x.req.headers).filter(([name]) => !HOP_BY_HOP.has(name) && !(body && name === "content-length")));
      const request = region.url.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = request(under(region.url, path), {
        method: x.req.method,
        headers: { ...headers, "x-request-id": x.id, ...(body && { "content-length": String(body.length) }) },
      });
      const gone = () => x.res.writableFinished || upstream.destroy();
      x.res.once("close", gone);
      upstream.on("error", (err) => {
        // The client went away first, and took this request with it.
        if (x.res.destroyed) return done();
        if (!x.res.headersSent) {
          x.log.error(`couldn't reach region ${region.name}`, { region: region.name, err });
          reply(x, 502, { error: `Region ${region.name} couldn't be reached: ${err.message}`, region: region.name });
        } else x.res.destroy();
        done();
      });
      upstream.on("response", (answer) => {
        head(x, answer.statusCode ?? 502, Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name))), region.name);
        x.res.flushHeaders();
        // An answer the region broke off is broken off here too, so the client knows it is incomplete.
        answer.once("close", () => {
          if (!answer.complete) x.res.destroy();
          done();
        });
        answer.pipe(x.res);
      });
      if (body) upstream.end(body);
      else x.req.pipe(upstream);
    });

  /** The usage of every region the tenant may use, summed: rows with the same day and model are one. */
  const usageEverywhere = async (x: Exchange, tenant: Tenant, path: string, query: URLSearchParams) => {
    if (query.get("format") === "csv") return reply(x, 400, { error: "region=all gives JSON: ask each region for its CSV" });
    // A client that leaves, or the router closing, takes the requests to the regions with it.
    const left = new AbortController();
    x.res.once("close", () => left.abort());
    const answers = await Promise.all(
      tenant.allowed.map(async (name) => {
        const region = regions.get(name)!;
        if (!region.up) return { name, status: 503, body: undefined };
        try {
          const res = await fetch(under(region.url, `${path}${query.size ? `?${query}` : ""}`), {
            headers: { authorization: x.req.headers.authorization ?? "", "x-request-id": x.id },
            signal: AbortSignal.any([probes.signal, left.signal, AbortSignal.timeout(30_000)]),
          });
          return { name, status: res.status, body: (await res.json().catch(() => undefined)) as UsageReport | undefined };
        } catch (err) {
          if (!probes.signal.aborted && !left.signal.aborted) x.log.error(`couldn't reach region ${name}`, { region: name, err });
          return { name, status: 502, body: undefined };
        }
      }),
    );
    // No one is left to answer, as forward() does: no reply, and no count.
    if (left.signal.aborted) return;
    const answered = answers.filter((answer) => answer.status === 200 && answer.body && Array.isArray(answer.body.rows));
    if (!answered.length) {
      // The regions' own refusal (a bad range, say) is the same in each: it goes back as it came.
      const refused = answers.find((answer) => answer.status >= 400 && answer.status < 500 && answer.body);
      if (refused) return reply(x, refused.status, refused.body!, {}, refused.name);
      return reply(x, 502, { error: "No region answered", regions: [] });
    }
    const names = answered.map((answer) => answer.name);
    return reply(x, 200, sumUsage(answered.map((answer) => answer.body!), names), {}, names.join(","));
  };

  const handle = async (x: Exchange): Promise<void> => {
    const { req } = x;
    // Requests go on with this parsed path and query, never req.url: a target in absolute form
    // (http://host/v1/...) or one that starts with // names a host of the client's choosing.
    const url = new URL(req.url ?? "/", "http://router");
    if (url.pathname === "/healthz") return reply(x, 200, { ok: true, regions: standing() });
    const key = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const tenant = key && tenants.get(createHash("sha256").update(key).digest("hex"));
    if (!tenant) return reply(x, 401, { error: "A tenant's API key is needed: Authorization: Bearer <key>" }, { "www-authenticate": "Bearer" });
    x.log = x.log.with({ tenant: tenant.id });
    const allowed = (name: string) => tenant.allowed.includes(name);

    if (url.pathname === "/v1/tasks" && req.method === "POST") {
      x.route = "create";
      let body: Buffer | undefined;
      try {
        body = await readBody(req, maxBody);
      } catch (err) {
        // A client that left before its body was read is not the router's fault: no answer, and no count.
        if (req.destroyed || x.res.destroyed) {
          x.log.debug("the client left before its body was read", { err });
          return void x.res.destroy();
        }
        throw err;
      }
      if (body === undefined) {
        x.res.setHeader("connection", "close");
        return reply(x, 413, { error: `The body is over ${maxBody} bytes` });
      }
      let named: unknown;
      try {
        named = (JSON.parse(body.toString("utf8")) as { region?: unknown })?.region;
      } catch {
        // The region's service says what is wrong with it.
      }
      if (named !== undefined) {
        // The service's own answer to a region that is no region's name.
        if (typeof named !== "string" || !REGION_NAME.test(named)) return reply(x, 400, { error: "region must be a region's name" });
        if (!allowed(named)) return reply(x, 403, { error: `Tenant ${tenant.id} may not use region ${JSON.stringify(named)}: it may use ${tenant.allowed.join(", ")}`, region: named });
        const region = regions.get(named)!;
        if (!region.up) return down(x, named, "try again once it is back, or name another region");
        return forward(x, region, url.pathname + url.search, body);
      }
      let region = regions.get(tenant.home)!;
      if (!region.up) {
        const other = tenant.failover ? order.map((name) => regions.get(name)!).find((other) => other.up && allowed(other.name)) : undefined;
        if (!other) return down(x, tenant.home, "try again once it is back");
        failovers.inc({ from: region.name, to: other.name });
        x.log.info(`a new task goes to region ${other.name}: its home, ${region.name}, is down`, { region: other.name });
        region = other;
      }
      return forward(x, region, url.pathname + url.search, body);
    }

    const task = /^\/v1\/tasks\/([^/]+)(\/[^/]+)?/.exec(url.pathname);
    if (task) {
      x.route = { "/events": "events", "/cancel": "cancel", "/approvals": "approvals" }[task[2] ?? ""] ?? "task";
      // An id without a region is from before regions: it lives in the home region.
      const name = REGIONAL_ID.exec(task[1])?.[1] ?? (LEGACY_ID.test(task[1]) ? tenant.home : undefined);
      // Only an id's shape is put in the log, never any other text from the path.
      if (name !== undefined) x.log = x.log.with({ task: task[1] });
      if (name === undefined || !regions.has(name) || !allowed(name)) return reply(x, 404, { error: "No such task" });
      const region = regions.get(name)!;
      if (!region.up) return down(x, name, "its tasks can't be read or changed until it is back (task data stays in its region)");
      return forward(x, region, url.pathname + url.search);
    }

    // The tenant's list, and its usage, are each region's own: ?region= picks one (the home by default).
    const listed = url.pathname === "/v1/tasks" ? "list" : url.pathname === "/v1/usage" ? "usage" : undefined;
    x.route = listed ?? "other";
    // Read once, as the service reads its own: region=us&region=eu would otherwise answer for us alone.
    if (listed && url.searchParams.getAll("region").length > 1) return reply(x, 400, { error: "region may be given once" });
    const asked = listed && url.searchParams.get("region");
    url.searchParams.delete("region");
    if (asked === "all" && listed === "usage") return usageEverywhere(x, tenant, url.pathname, url.searchParams);
    if (asked && (!regions.has(asked) || !allowed(asked))) return reply(x, asked === "all" ? 400 : 403, { error: asked === "all" ? "region=all is for /v1/usage" : `Tenant ${tenant.id} may not use region ${JSON.stringify(asked)}: it may use ${tenant.allowed.join(", ")}`, region: asked });
    const region = regions.get(asked || tenant.home)!;
    if (!region.up) return down(x, region.name, "try again once it is back");
    return forward(x, region, url.pathname + url.search);
  };

  const server = createServer((req, res) => {
    const given = req.headers["x-request-id"];
    const id = typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
    const x: Exchange = { req, res, id, started: performance.now(), route: "other", log: log.with({ request: id }) };
    handle(x).catch((err: unknown) => {
      x.log.error("couldn't route a request", { err });
      if (!res.headersSent) reply(x, 500, { error: "Internal error" });
      else res.destroy();
    });
  });
  const metricsServer =
    config.metrics &&
    createServer((req, res) => {
      const path = req.url?.split("?")[0];
      if (req.method === "GET" && path === "/metrics") return void registry.serve(res).catch(() => res.destroy());
      if (req.method === "GET" && path === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end(`${JSON.stringify({ ok: true, regions: standing() })}\n`);
      res.writeHead(404, { "content-type": "application/json" }).end(`${JSON.stringify({ error: "Only GET /metrics and GET /healthz here" })}\n`);
    });
  const listeners = [server, ...(metricsServer ? [metricsServer] : [])];
  const close = async () => {
    clearInterval(timer);
    probes.abort();
    for (const listener of listeners) listener.closeAllConnections();
    await Promise.all(listeners.filter((listener) => listener.listening).map((listener) => new Promise((done) => listener.close(done))));
  };
  try {
    const url = await listen(server, config.listen?.port ?? 8090, config.listen?.host ?? "127.0.0.1");
    const metricsUrl = metricsServer && (await listen(metricsServer, config.metrics!.port, config.metrics!.host ?? "127.0.0.1"));
    return { url, ...(metricsUrl && { metricsUrl }), regions: standing, close };
  } catch (err) {
    await close();
    throw err;
  }
}

interface UsageRow {
  day?: string;
  model?: string;
  [field: string]: unknown;
}

interface UsageReport {
  from?: string;
  to?: string;
  rows: UsageRow[];
  total?: Record<string, unknown>;
}

/** Several regions' usage as one report: their numbers added up, row by row (same day and model) and in total. */
export function sumUsage(reports: UsageReport[], regions: string[]): object {
  const add = (into: Record<string, unknown>, from: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(from)) {
      if (typeof value !== "number") into[field] ??= value;
      else into[field] = Math.round(((typeof into[field] === "number" ? (into[field] as number) : 0) + value) * 1e9) / 1e9;
    }
    return into;
  };
  const rows = new Map<string, UsageRow>();
  const total: Record<string, unknown> = {};
  for (const report of reports) {
    for (const row of report.rows) {
      const key = JSON.stringify([row.day ?? null, row.model ?? null]);
      rows.set(key, add(rows.get(key) ?? {}, row));
    }
    if (isObject(report.total)) add(total, report.total);
  }
  const sorted = [...rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
  return { from: reports[0]!.from, to: reports[0]!.to, rows: sorted, total, regions };
}

/** The request's body, or undefined once it is over `max` bytes (the rest isn't read). */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  if (Number(req.headers["content-length"]) > max) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The URL as a base that paths join onto, keeping its own path (https://eu.example.com/jig/ + v1/tasks). */
function withSlash(url: URL): URL {
  return new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
}

/**
 * The path and query on the region's URL, under its own path. Joined as text, never resolved as a URL: a
 * path like //host/... or https:host/... would otherwise name another host, and take the tenant's key there.
 */
function under(region: URL, path: string): URL {
  return new URL(withSlash(region).href + path.replace(/^\/+/, ""));
}

async function listen(server: Server, port: number, host: string): Promise<string> {
  await new Promise<void>((done, fail) => server.once("error", fail).listen(port, host, () => (server.off("error", fail), done())));
  const { address, port: bound } = server.address() as AddressInfo;
  return `http://${address.includes(":") ? `[${address}]` : address}:${bound}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Usage: node server/router.ts --config <file>");
  const config: RouterConfig = JSON.parse(readFileSync(values.config, "utf8"));
  const log = createLog("router");
  const router = await startRouter(config, { log });
  log.info(`listening on ${router.url}${router.metricsUrl ? `, metrics on ${router.metricsUrl}` : ""}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log.info("stopping");
      void router.close().then(() => process.exit(0));
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
