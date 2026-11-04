#!/usr/bin/env node
// The model gateway: jig's tasks call the Messages API through it with a token of their own (token.ts),
// and it calls the provider with a real key from its pool, so a sandbox never holds one. Each tenant's
// requests are held to its limits (limits.ts), and what each task and tenant spent is counted from the
// replies, in this process or, for several replicas acting as one, in Redis (state.ts). The body goes
// upstream byte for byte (prompt caching depends on it) and the reply comes back as it arrives; only the
// credentials change. docs/server.md describes the routes and the config.
//
//   node server/gateway.ts --config gateway.json

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Usage } from "../src/agent.ts";
import { costOf, PRICES } from "../src/prices.ts";
import { type Admission, type Limits, Limiter } from "./limits.ts";
import { parseRedisUrl } from "./redis.ts";
import { MemoryState, RedisState, SharedState, type Spent, type State, StateError } from "./state.ts";
import { type TokenPayload, verifyToken } from "./token.ts";

export interface GatewayConfig {
  /** Where to listen (default: 127.0.0.1, port 8787). */
  listen?: { host?: string; port?: number };
  upstream: {
    /** The provider's Anthropic-compatible base URL: https://api.anthropic.com, https://api.deepseek.com/anthropic. */
    baseUrl: string;
    /** The environment variables holding the pool's keys. */
    keyEnv: string[];
  };
  limits?: Limits & {
    /** How long a request over a limit waits for its turn, in milliseconds (default: 30 seconds). */
    maxWaitMs?: number;
    tenantDefaults?: Limits;
    tenants?: Record<string, Limits>;
  };
  /** The environment variable holding a token that may read any task's usage. */
  adminTokenEnv?: string;
  /**
   * Limits, spending and the keys' standing in Redis, shared by every gateway with the same URL and prefix,
   * so they can run as replicas; without it, in this process.
   */
  state?: {
    /** redis://[[username]:password@]host:port[/db], or rediss:// for TLS. */
    redis: string;
    /** Before every key (default: "jig:gw:"). */
    prefix?: string;
    /** How long a request's slot outlives a gateway that died with it, in milliseconds (default: 60 seconds). */
    leaseMs?: number;
    /** Redis can't be reached: refuse requests with 503 ("closed", the default), or use this replica's own limits and counts ("open"). */
    onStateError?: "closed" | "open";
  };
}

export interface Gateway {
  url: string;
  close(): Promise<void>;
}

// Not forwarded either way: they describe one connection, not the request. The credentials and the
// encoding are the gateway's own to set.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const SET_HERE = new Set(["x-api-key", "authorization", "accept-encoding"]);

/** A long conversation is a few megabytes; this is far past any the API takes. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** How long a key the provider rate-limited rests when its reply gives no retry-after. */
const DEFAULT_COOL_DOWN_MS = 30_000;

/** A reply in the Messages API's error format, so jig's SDK reads it as it reads the provider's. */
function fail(res: ServerResponse, status: number, type: string, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return void res.destroy();
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/** The credential as the Anthropic SDK sends a key (x-api-key) or the OpenAI SDK does (a bearer token). */
function credential(headers: IncomingHttpHeaders): string {
  const key = headers["x-api-key"];
  return (typeof key === "string" && key) || (headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

interface Key {
  name: string;
  value: string;
  /** What other gateways know it by: never the key itself. */
  id: string;
  /** Refused by the provider (401 or 403): never used again. */
  bad: boolean;
  /** Rate-limited by the provider: rests until then. */
  coolUntil: number;
}

/** The upstream keys, taken in turn, passing over a bad one and one that is cooling down. */
class KeyPool {
  readonly keys: Key[];
  private next = 0;

  constructor(keys: Key[]) {
    this.keys = keys;
  }

  /** Takes in what other gateways learned of the keys: which the provider refused, and which rest. */
  async refresh(state: State): Promise<void> {
    if (!state.keys) return;
    const shared = await state.keys(this.keys.map((key) => key.id));
    shared.forEach(({ bad, coolUntil }, i) => {
      this.keys[i].bad ||= bad;
      this.keys[i].coolUntil = Math.max(this.keys[i].coolUntil, coolUntil);
    });
  }

  /** The next usable key not in `tried`, without taking it with `peek`. */
  take(tried: Set<Key>, peek = false): Key | undefined {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const index = (this.next + i) % this.keys.length;
      const key = this.keys[index];
      if (key.bad || key.coolUntil > now || tried.has(key)) continue;
      if (!peek) this.next = index + 1;
      return key;
    }
    return undefined;
  }

  /** Seconds until a key that is cooling down is usable again, or undefined when every key is bad. */
  retryAfter(): number | undefined {
    const cooling = this.keys.filter((key) => !key.bad).map((key) => key.coolUntil - Date.now());
    return cooling.length ? Math.max(1, Math.ceil(Math.min(...cooling) / 1000)) : undefined;
  }
}

/** Milliseconds a retry-after header asks for (seconds, or an HTTP date), or the default. */
function retryAfterMs(header: string | string[] | undefined): number {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return DEFAULT_COOL_DOWN_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? DEFAULT_COOL_DOWN_MS : Math.max(0, date - Date.now());
}

const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** The Messages API's usage object as jig counts it; fields it leaves out are left out. */
function usageFrom(usage: unknown): Partial<Usage> {
  const u = (usage ?? {}) as Record<string, unknown>;
  const fields: [keyof Usage, string][] = [["input", "input_tokens"], ["cacheRead", "cache_read_input_tokens"], ["cacheWrite", "cache_creation_input_tokens"], ["output", "output_tokens"]];
  return Object.fromEntries(fields.flatMap(([ours, theirs]) => (typeof u[theirs] === "number" ? [[ours, u[theirs]]] : [])));
}

/**
 * Reads a reply's usage as it passes: a stream's message_start and message_delta events (the delta's
 * counts are totals so far, so the last one stands), or a whole reply's body.
 */
class UsageReader {
  usage: Usage = { ...NO_USAGE };
  model?: string;
  private readonly stream: boolean;
  private readonly decoder = new TextDecoder();
  private text = "";
  private size = 0;

  constructor(stream: boolean) {
    this.stream = stream;
  }

  add(chunk: Buffer): void {
    this.text += this.decoder.decode(chunk, { stream: true });
    if (!this.stream) {
      // A body too large to hold is not a reply; its usage goes uncounted rather than filling memory.
      this.size += chunk.length;
      if (this.size > MAX_BODY_BYTES) this.text = "";
      return;
    }
    const events = this.text.split(/\r?\n\r?\n/);
    this.text = events.pop() ?? "";
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      try {
        this.read(JSON.parse(data));
      } catch {
        // a comment, a ping, or not JSON: no usage in it
      }
    }
  }

  end(): void {
    if (this.stream || !this.text) return;
    try {
      this.read({ type: "message_start", message: JSON.parse(this.text) });
    } catch {
      // not a reply: no usage
    }
  }

  private read(event: { type?: string; message?: { model?: unknown; usage?: unknown }; usage?: unknown }): void {
    if (event.type === "message_start") {
      if (typeof event.message?.model === "string") this.model = event.message.model;
      this.usage = { ...this.usage, ...usageFrom(event.message?.usage) };
    } else if (event.type === "message_delta") {
      this.usage = { ...this.usage, ...usageFrom(event.usage) };
    }
  }
}

/** Counters and gauges, written in Prometheus's text format. */
class Metrics {
  private readonly values = new Map<string, Map<string, number>>();
  private readonly help: Record<string, [type: string, text: string]> = {
    jig_gateway_requests_total: ["counter", "Messages API requests with a valid token, by tenant."],
    jig_gateway_rate_limited_total: ["counter", "Requests answered with 429, the gateway's own and the provider's, by tenant."],
    jig_gateway_budget_exceeded_total: ["counter", "Requests answered with 402 because the task's budget was spent, by tenant."],
    jig_gateway_upstream_errors_total: ["counter", "Provider replies with status 5xx, 401 or 403, and requests that could not reach it."],
    jig_gateway_tokens_total: ["counter", "Tokens the provider counted, by tenant and kind."],
    jig_gateway_cost_usd_total: ["counter", "What the priced replies cost, in USD, by tenant."],
    jig_gateway_state_errors_total: ["counter", "Reads and writes of the shared state (Redis) that failed."],
    jig_gateway_in_flight: ["gauge", "Requests sent upstream whose reply is not over."],
    jig_gateway_queued: ["gauge", "Requests waiting for their turn."],
  };

  add(name: string, labels: Record<string, string>, by = 1): void {
    const key = Object.entries(labels)
      .map(([label, value]) => `${label}="${value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n")}"`)
      .join(",");
    const series = this.values.get(name) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + by);
    this.values.set(name, series);
  }

  text(gauges: Record<string, number>): string {
    const lines: string[] = [];
    for (const [name, [type, help]] of Object.entries(this.help)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      if (name in gauges) lines.push(`${name} ${gauges[name]}`);
      for (const [labels, value] of this.values.get(name) ?? []) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The config's mistakes, said before the gateway starts rather than at its first request. */
function check(config: GatewayConfig, env: NodeJS.ProcessEnv): void {
  if (!env.JIG_GATEWAY_SECRET) throw new Error("Set JIG_GATEWAY_SECRET, the secret the task service signs tokens with.");
  const base = config.upstream?.baseUrl;
  if (typeof base !== "string" || !/^https?:\/\//.test(base)) throw new Error("upstream.baseUrl must be an http or https URL.");
  const names = config.upstream.keyEnv;
  if (!Array.isArray(names) || !names.length) throw new Error("upstream.keyEnv must name at least one environment variable holding a key.");
  const missing = names.filter((name) => !env[name]);
  if (missing.length) throw new Error(`No key in ${missing.join(", ")}.`);
  if (config.state) {
    try {
      parseRedisUrl(config.state.redis);
    } catch (err) {
      throw new Error(`state.redis must be a Redis URL, redis://[:password@]host:port[/db]: ${(err as Error).message}`);
    }
    const { onStateError } = config.state;
    if (onStateError !== undefined && onStateError !== "closed" && onStateError !== "open") throw new Error('state.onStateError must be "closed" or "open".');
  }
}

/** Starts a gateway with `config`, its secret and keys read from `env`. */
export async function startGateway(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env): Promise<Gateway> {
  check(config, env);
  const secret = env.JIG_GATEWAY_SECRET!;
  const base = new URL(config.upstream.baseUrl);
  const keyId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const pool = new KeyPool(config.upstream.keyEnv.map((name) => ({ name, value: env[name]!, id: keyId(env[name]!), bad: false, coolUntil: 0 })));
  const metrics = new Metrics();
  metrics.add("jig_gateway_state_errors_total", {}, 0);
  const state: State = config.state
    ? new SharedState(new RedisState(config.state.redis, { prefix: config.state.prefix, leaseMs: config.state.leaseMs }), {
        onStateError: config.state.onStateError ?? "closed",
        onError: () => metrics.add("jig_gateway_state_errors_total", {}),
      })
    : new MemoryState();
  const { maxWaitMs = 30_000, tenantDefaults, tenants, ...global } = config.limits ?? {};
  const limiter = new Limiter({ global, tenantDefaults, tenants, maxWaitMs }, state);
  const admin = config.adminTokenEnv ? env[config.adminTokenEnv] : undefined;

  const isAdmin = (given: string): boolean => {
    if (!admin || !given) return false;
    const digest = (text: string) => createHash("sha256").update(text).digest();
    return timingSafeEqual(digest(given), digest(admin));
  };

  /** Counts a reply's usage toward its task and tenant, priced by the model the reply names, or the request did. */
  const meter = async (token: TokenPayload, requested: string | undefined, reader: UsageReader): Promise<void> => {
    const model = reader.model && PRICES[reader.model] ? reader.model : requested;
    const cost = model ? costOf(model, reader.usage) : undefined;
    for (const [kind, n] of Object.entries(reader.usage)) if (n) metrics.add("jig_gateway_tokens_total", { tenant: token.tenant, kind }, n);
    if (cost) metrics.add("jig_gateway_cost_usd_total", { tenant: token.tenant }, cost);
    // Without Redis ("closed"), what the reply cost goes uncounted: it is counted as a state error and said.
    await state.spend(token, reader.usage, cost).catch(() => {});
  };

  /** One request to the provider with `key`; resolves with its reply's status and headers. */
  const send = (path: string, headers: IncomingHttpHeaders, body: Buffer, key: Key, signal: AbortSignal): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const request = base.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = request(new URL(base.pathname.replace(/\/$/, "") + path, base.origin), {
        method: "POST",
        // Plain bytes back, so the usage in them can be read on the way through.
        headers: { ...headers, "x-api-key": key.value, "accept-encoding": "identity", "content-length": String(body.length) },
        signal,
      });
      upstream.on("response", resolve).on("error", reject).end(body);
    });

  /**
   * Sends the request with a key from the pool and passes the reply back as it comes. A key the provider
   * refuses is marked bad and one it rate-limits cools down; either way the request goes once to each other
   * usable key. With none left, a rate limit goes back to jig as it came, retry-after and all, and jig's SDK
   * waits that long: no storm of retries from here.
   */
  const forward = async (req: IncomingMessage, res: ServerResponse, token: TokenPayload, body: Buffer, model: string | undefined, signal: AbortSignal): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const path = url.pathname.replace(/^\/anthropic/, "") + url.search;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name) && !SET_HERE.has(name)));
    const tried = new Set<Key>();
    await pool.refresh(state);
    for (;;) {
      const key = pool.take(tried);
      if (!key) {
        const retryAfter = pool.retryAfter();
        if (retryAfter === undefined) return fail(res, 502, "api_error", "The gateway's provider keys were all refused; an operator must replace them.");
        metrics.add("jig_gateway_rate_limited_total", { tenant: token.tenant });
        return fail(res, 429, "rate_limit_error", "Every provider key is rate-limited; try again later.", { "retry-after": String(retryAfter) });
      }
      tried.add(key);
      let reply: IncomingMessage;
      try {
        reply = await send(path, headers, body, key, signal);
      } catch (err) {
        if (signal.aborted) return;
        metrics.add("jig_gateway_upstream_errors_total", { status: "unreachable" });
        return fail(res, 502, "api_error", `The gateway could not reach ${base.host}: ${(err as Error).message}`);
      }
      if (signal.aborted) return void reply.destroy(); // jig went away while the provider answered
      const status = reply.statusCode ?? 502;
      const refused = status === 401 || status === 403;
      if (refused || status >= 500) metrics.add("jig_gateway_upstream_errors_total", { status: String(status) });
      if (refused) {
        key.bad = true;
        void state.markKey?.(key.id, "bad");
      }
      if (status === 429) {
        key.coolUntil = Date.now() + retryAfterMs(reply.headers["retry-after"]);
        void state.markKey?.(key.id, key.coolUntil);
      }
      if (refused || status === 429) {
        if (pool.take(tried, true)) {
          reply.resume();
          continue;
        }
        if (refused) {
          reply.resume();
          return fail(res, 502, "api_error", `The provider refused the gateway's key (${status}); an operator must replace it.`);
        }
        metrics.add("jig_gateway_rate_limited_total", { tenant: token.tenant });
      }
      const reader = new UsageReader(/event-stream/.test(String(reply.headers["content-type"])));
      res.writeHead(status, Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name))));
      res.flushHeaders();
      reply.on("data", (chunk: Buffer) => reader.add(chunk));
      // Counted however the reply ends: tokens the provider sent before jig went away were spent too.
      let counted: Promise<void> | undefined;
      const count = () => (counted ??= (reader.end(), status === 200 ? meter(token, model, reader) : Promise.resolve()));
      // jig's reply ends once it is counted, so the task's next request, through any replica, sees it.
      reply.once("end", () => void count().finally(() => res.end()));
      reply.once("close", () => {
        void count();
        // A reply the provider broke off never ends, so jig's would stay open; breaking it off too lets jig
        // ask again at once, and gives back the request's slot.
        if (!reply.complete) res.destroy();
      });
      reply.pipe(res, { end: false });
      if (!res.closed) await new Promise((done) => res.once("close", done));
      return;
    }
  };

  const messages = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = verifyToken(secret, credential(req.headers));
    if (token instanceof Error) return fail(res, 401, "authentication_error", `Not a valid gateway token: ${token.message}.`);
    metrics.add("jig_gateway_requests_total", { tenant: token.tenant });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(res, 413, "request_too_large", "The request is larger than the gateway takes.");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    let model: string | undefined;
    try {
      const parsed = JSON.parse(body.toString("utf8")).model;
      if (typeof parsed === "string") model = parsed;
    } catch {
      // the provider says what is wrong with it
    }
    if (token.budgetUsd !== null) {
      // Nothing spent yet is $0, so a budget of 0 refuses the first request too.
      const spentUsd = (await state.spent(token.tenant, token.task))?.costUsd ?? 0;
      if (spentUsd >= token.budgetUsd) {
        metrics.add("jig_gateway_budget_exceeded_total", { tenant: token.tenant });
        return fail(res, 402, "billing_error", `This task has spent its budget: $${spentUsd.toFixed(4)} of $${token.budgetUsd}.`);
      }
      // A budget the gateway can't price toward would not hold.
      if (!model || !PRICES[model]) {
        return fail(res, 400, "invalid_request_error", `A task with a budget can only use a model with a price (${Object.keys(PRICES).join(", ")}).`);
      }
    }
    const client = new AbortController();
    res.once("close", () => res.writableFinished || client.abort()); // jig went away: so does the request
    const admission: Admission = await limiter.acquire(token.tenant, client.signal);
    if ("retryAfter" in admission) {
      if (client.signal.aborted) return;
      if (admission.error) throw admission.error;
      metrics.add("jig_gateway_rate_limited_total", { tenant: token.tenant });
      return fail(res, 429, "rate_limit_error", "This tenant's requests are over its limits; try again later.", { "retry-after": String(admission.retryAfter) });
    }
    try {
      await forward(req, res, token, body, model, client.signal);
    } finally {
      admission.release();
    }
  };

  /** A task's spending, to its own token, or to the admin token with ?tenant=: task ids are only unique within a tenant. */
  const usage = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    let task: string;
    try {
      task = decodeURIComponent(url.pathname.slice("/usage/".length));
    } catch {
      return fail(res, 400, "invalid_request_error", "The task in the path is not percent-encoded right.");
    }
    const given = credential(req.headers);
    const token = verifyToken(secret, given);
    const asked = url.searchParams.get("tenant");
    let tenant: string;
    if (isAdmin(given)) {
      if (!asked) return fail(res, 400, "invalid_request_error", "Name the task's tenant: /usage/<task>?tenant=<tenant>.");
      tenant = asked;
    } else {
      if (token instanceof Error) return fail(res, 401, "authentication_error", `Not a valid gateway token: ${token.message}.`);
      if (token.task !== task || (asked !== null && asked !== token.tenant)) return fail(res, 403, "permission_error", "A task's token reads only its own usage.");
      tenant = token.tenant;
    }
    // A task's own token reads nothing spent yet as zeros; to an admin, a task the gateway hasn't seen is unknown.
    const nothing: Spent | undefined = token instanceof Error ? undefined : { tenant, requests: 0, usage: { ...NO_USAGE }, costUsd: 0, unpriced: 0, budgetUsd: token.budgetUsd };
    const found = (await state.spent(tenant, task)) ?? nothing;
    if (!found) return fail(res, 404, "not_found_error", `No usage for task ${task} of ${tenant}.`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ task, ...found }));
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;
    if (route === "POST /anthropic/v1/messages") return messages(req, res);
    if (route === "GET /healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (route === "GET /metrics") {
      const gauges = { jig_gateway_in_flight: limiter.inFlight, jig_gateway_queued: limiter.queued };
      return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(metrics.text(gauges));
    }
    if (req.method === "GET" && pathname.startsWith("/usage/")) return usage(req, res, url);
    fail(res, 404, "not_found_error", `The gateway has no ${route}.`);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err) => {
      if (err instanceof StateError) return fail(res, 503, "api_error", `${err.message}; try again shortly.`, { "retry-after": "1" });
      fail(res, 500, "api_error", `The gateway failed: ${(err as Error).message}`);
    });
  });
  const { host = "127.0.0.1", port = 8787 } = config.listen ?? {};
  await new Promise<void>((done, failed) => server.once("error", failed).listen(port, host, done));
  const address = server.address() as AddressInfo;
  return {
    url: `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      limiter.close();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      // The requests just broken off give their slots back before the state goes.
      await limiter.settle(2000);
      state.close();
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help || !values.config) {
    console.log("Usage: node server/gateway.ts --config <file>\n\nThe model gateway; docs/server.md describes the config.");
    process.exit(values.help ? 0 : 1);
  }
  let gateway: Gateway;
  try {
    gateway = await startGateway(JSON.parse(readFileSync(values.config, "utf8")));
  } catch (err) {
    console.error(`jig gateway: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`jig gateway listening on ${gateway.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => gateway.close().then(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
