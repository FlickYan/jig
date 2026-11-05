#!/usr/bin/env node
// The model gateway: jig's tasks call the Messages API through it with a token of their own (token.ts),
// and it calls the provider with a real key from its pool, so a sandbox never holds one. Each tenant's
// requests are held to its limits (limits.ts) and its daily and monthly quotas, and what each task and
// tenant spent is counted from the replies, in this process or, for several replicas acting as one, in
// Redis (state.ts). The body goes upstream byte for byte (prompt caching depends on it) and the reply
// comes back as it arrives; only the credentials change, and the model where an upstream calls it by
// another id. With several upstreams, a request goes on to the next one when an upstream fails it before
// its reply starts, and an upstream that keeps failing is passed over for a while (Breaker). Its metrics
// are served on a listener of their own, and each reply carries an x-request-id, which its log lines carry
// too. docs/server.md describes the routes and the config.
//
//   node server/gateway.ts --config gateway.json

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Usage } from "../src/agent.ts";
import { costOf, PRICES } from "../src/prices.ts";
import { type Admission, type Limits, Limiter } from "./limits.ts";
import { createLog, logFormat, logLevel } from "./log.ts";
import { Registry } from "./metrics.ts";
import { parseRedisUrl } from "./redis.ts";
import { MemoryState, RedisState, SharedState, type Spent, type State, StateError, utcDay } from "./state.ts";
import { type TokenPayload, verifyToken } from "./token.ts";

export interface UpstreamConfig {
  /** The provider's Anthropic-compatible base URL: https://api.anthropic.com, https://api.deepseek.com/anthropic. */
  baseUrl: string;
  /** The environment variables holding the pool's keys. */
  keyEnv: string[];
}

export interface GatewayConfig {
  /** Where to listen (default: 127.0.0.1, port 8787). */
  listen?: { host?: string; port?: number };
  /** A listener of its own for GET /metrics and GET /healthz (host default: 127.0.0.1); none without it. */
  metrics?: { host?: string; port: number };
  /** One provider: the same as `upstreams` with one, named "default", with no `models`. */
  upstream?: UpstreamConfig;
  /** The providers, in the order a request tries them; give this or `upstream`, not both. */
  upstreams?: (UpstreamConfig & {
    /** ^[a-z0-9-]{1,32}$, unique: what x-jig-upstream, /usage and the logs call it. */
    name: string;
    /** The only models it serves, each jig model id to the provider's; without it, any model, unchanged. */
    models?: Record<string, string>;
  })[];
  /** When a request goes on to the next upstream, and when one is passed over for a while. */
  failover?: {
    /** How long an upstream has to send its reply's headers, in milliseconds (default: 60 seconds). */
    firstByteMs?: number;
    /** How long a reply passed back may send nothing before it is broken off, in milliseconds (default: 120 seconds). */
    idleMs?: number;
    /** Failures in a row that open an upstream's circuit (default: 5). */
    failures?: number;
    /** How long an open circuit passes the upstream over before one request tries it, in milliseconds (default: 30 seconds). */
    openMs?: number;
  };
  limits?: Omit<Limits, "dailyUsd" | "monthlyUsd"> & {
    /** How long a request over a limit waits for its turn, in milliseconds (default: 30 seconds). */
    maxWaitMs?: number;
    /** For a tenant `tenants` doesn't name. The quotas (dailyUsd, monthlyUsd) are a tenant's own: here or there, not above. */
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
    /** How long a request's slot outlives a gateway that died with it, in milliseconds, 100 or more (default: 60 seconds). */
    leaseMs?: number;
    /** Redis can't be reached: refuse requests with 503 ("closed", the default), or use this replica's own limits and counts ("open"). */
    onStateError?: "closed" | "open";
  };
}

export interface Gateway {
  url: string;
  /** The metrics listener's, with `metrics` in the config. */
  metricsUrl?: string;
  close(): Promise<void>;
}

// Not forwarded either way: they describe one connection, not the request; and x-request-id is the
// gateway's own, which neither jig's nor the provider's takes the place of. The credentials and the
// encoding are the gateway's own to set.
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "x-request-id"]);
const SET_HERE = new Set(["x-api-key", "authorization", "accept-encoding"]);

/** A request id a client may give in x-request-id; any other gets a new one. */
const REQUEST_ID = /^[\w.-]{1,128}$/;

/** The request's id: the client's, if it gave one that will do, or a new one. */
function requestId(req: IncomingMessage): string {
  const given = req.headers["x-request-id"];
  return typeof given === "string" && REQUEST_ID.test(given) ? given : randomUUID();
}

/** The longest range of days GET /usage reads at once: a year's, a leap year's included. */
const MAX_USAGE_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of a UTC day given as YYYY-MM-DD, in milliseconds; undefined for anything else, 2026-02-30 included. */
function dayStart(day: string): number | undefined {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day) : NaN;
  return Number.isNaN(ms) || utcDay(ms) !== day ? undefined : ms;
}

/**
 * An amount in USD as a refusal says it: to the millionth, without trailing zeros, so a spend past a small
 * budget doesn't read as the budget itself ($0.00014 of $0.0001, not $0.0001 of $0.0001).
 */
function usd(amount: number): string {
  return String(Number(amount.toFixed(6)));
}

/** A long conversation is a few megabytes; this is far past any the API takes. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** How long a key the provider rate-limited rests when its reply gives no retry-after. */
const DEFAULT_COOL_DOWN_MS = 30_000;

/**
 * A provider's replies that send the request on to the next upstream: it is down or overloaded, and may
 * not be elsewhere. 429 (once no key of the pool is left) too. Any other status goes back to jig as it is:
 * a bad request is bad everywhere.
 */
const FAILOVER_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/** The most of a failed reply's body kept to send back; past it, the gateway says what happened itself. */
const MAX_ERROR_BYTES = 1024 * 1024;

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
  /** Refused by the provider (401 or 403): not used again until a restart, or with `state` while Redis has its mark. */
  bad: boolean;
  /** Rate-limited by the provider: rests until then. */
  coolUntil: number;
  /** This gateway's marks of it on their way to the state, and when the last one got there. */
  marking: number;
  markedAt: number;
}

/** The upstream keys, taken in turn, passing over a bad one and one that is cooling down. */
class KeyPool {
  readonly keys: Key[];
  private next = 0;

  constructor(keys: Key[]) {
    this.keys = keys;
  }

  /**
   * Takes in what the gateways know of the keys: which the provider refused, and which rest. What is shared
   * stands, so a mark that expired or that an operator removed is gone here too; only a mark of this
   * gateway's own that the read may not have seen yet is kept as well. Without the state, nothing changes.
   */
  async refresh(state: State): Promise<void> {
    if (!state.keys) return;
    const asked = Date.now();
    const shared = await state.keys(this.keys.map((key) => key.id));
    shared?.forEach(({ bad, coolUntil }, i) => {
      const key = this.keys[i];
      const fresh = key.marking > 0 || key.markedAt >= asked;
      key.bad = bad || (fresh && key.bad);
      key.coolUntil = fresh ? Math.max(key.coolUntil, coolUntil) : coolUntil;
    });
  }

  /** Marks `key` refused or resting until a time, here and in the state for the other gateways. */
  mark(state: State, key: Key, mark: "bad" | number): void {
    if (mark === "bad") key.bad = true;
    else key.coolUntil = mark;
    if (!state.markKey) return;
    key.marking++;
    void state.markKey(key.id, mark).finally(() => {
      key.marking--;
      key.markedAt = Date.now();
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

/**
 * An upstream's circuit breaker, this replica's own: `limit` failures in a row open it, and it passes the
 * upstream over for `openMs`; then one request at a time goes as a probe, and the probe's reply closes it
 * or opens it again. Only failures that send a request on count, and not those of the keys (a rate limit,
 * or every key resting or refused): a resting key passes the upstream over for its own retry-after, no
 * longer, and a breaker opened by it would hold for `openMs`. A reply that goes back to jig, 4xx included,
 * is the upstream answering.
 */
export class Breaker {
  private failures = 0;
  /** When the open circuit lets a probe through; 0 while it is closed. */
  private openUntil = 0;
  private probing = false;
  private readonly limit: number;
  private readonly openMs: number;

  constructor(limit: number, openMs: number) {
    this.limit = limit;
    this.openMs = openMs;
  }

  /** Lets a request through: "closed", or "probe" for the one request an open circuit lets try; undefined passes it over. */
  take(now = Date.now()): "closed" | "probe" | undefined {
    if (!this.openUntil) return "closed";
    if (this.probing || now < this.openUntil) return undefined;
    this.probing = true;
    return "probe";
  }

  /** Open or half-open: passing the upstream over, or letting only a probe through. */
  get open(): boolean {
    return this.openUntil > 0;
  }

  /** Milliseconds until an open circuit lets a probe through. */
  wait(now = Date.now()): number {
    return Math.max(0, this.openUntil - now);
  }

  /** The upstream answered; true when that closed the circuit. */
  succeeded(): boolean {
    const was = this.openUntil > 0;
    this.failures = 0;
    this.openUntil = 0;
    this.probing = false;
    return was;
  }

  /** The request failed over; true when that opened the circuit. */
  failed(taken: "closed" | "probe", now = Date.now()): boolean {
    if (taken === "probe") this.probing = false;
    // A request that went before the circuit opened adds nothing to it.
    else if (this.openUntil || ++this.failures < this.limit) return false;
    this.failures = 0;
    this.openUntil = now + this.openMs;
    return true;
  }

  /** The request ended with no word on the upstream (jig went away, or its keys failed it): another may probe. */
  abandoned(taken: "closed" | "probe"): void {
    if (taken === "probe") this.probing = false;
  }
}

/**
 * The body with its top-level "model" set to `model`, the rest byte for byte, since prompt caching depends
 * on it. The scan is over bytes: JSON's quotes, braces and backslashes are ASCII, never part of a
 * multi-byte character. A body whose key it can't find (an escaped one) is written out again whole.
 */
export function withModel(body: Buffer, model: string): Buffer {
  const QUOTE = 0x22, BACKSLASH = 0x5c, COLON = 0x3a;
  const stringEnd = (start: number) => {
    let i = start + 1;
    while (i < body.length && body[i] !== QUOTE) i += body[i] === BACKSLASH ? 2 : 1;
    return i + 1;
  };
  const skipSpace = (i: number) => {
    while (i < body.length && [0x20, 0x09, 0x0a, 0x0d].includes(body[i])) i++;
    return i;
  };
  const spans: [number, number][] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === 0x7b || c === 0x5b) depth++; // { [
    else if (c === 0x7d || c === 0x5d) depth--; // } ]
    else if (c === QUOTE) {
      const end = stringEnd(i);
      const value = skipSpace(end);
      if (depth === 1 && body.subarray(i, end).toString() === '"model"' && body[value] === COLON) {
        const start = skipSpace(value + 1);
        if (body[start] === QUOTE) spans.push([start, stringEnd(start)]);
      }
      i = end - 1;
    }
  }
  if (!spans.length) return Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), model }));
  const parts: Buffer[] = [];
  let from = 0;
  for (const [start, end] of spans) {
    parts.push(body.subarray(from, start), Buffer.from(JSON.stringify(model)));
    from = end;
  }
  parts.push(body.subarray(from));
  return Buffer.concat(parts);
}

const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** Each kind of token as jig_gateway_tokens_total names it. */
const TOKEN_KINDS: Record<keyof Usage, string> = { input: "input", output: "output", cacheRead: "cache_read", cacheWrite: "cache_write" };

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

/** The config's mistakes, said before the gateway starts rather than at its first request. */
function check(config: GatewayConfig, env: NodeJS.ProcessEnv): void {
  if (!env.JIG_GATEWAY_SECRET) throw new Error("Set JIG_GATEWAY_SECRET, the secret the task service signs tokens with.");
  if (config.upstream && config.upstreams) throw new Error("Give upstream or upstreams, not both.");
  if (!config.upstream && (!Array.isArray(config.upstreams) || !config.upstreams.length)) throw new Error("Set upstream, or upstreams with at least one provider.");
  const seen = new Set<string>();
  for (const [i, upstream] of (config.upstreams ?? [config.upstream!]).entries()) {
    const where = config.upstreams ? `upstreams[${i}]` : "upstream";
    if (config.upstreams) {
      const { name, models } = upstream as NonNullable<GatewayConfig["upstreams"]>[number];
      if (typeof name !== "string" || !/^[a-z0-9-]{1,32}$/.test(name)) throw new Error(`${where}.name must be 1 to 32 of a-z, 0-9 and -.`);
      if (seen.has(name)) throw new Error(`${where}.name: two upstreams are named ${name}.`);
      seen.add(name);
      const mapped = models === undefined || (typeof models === "object" && models !== null && !Array.isArray(models) && Object.values(models).every((id) => typeof id === "string" && id));
      if (!mapped) throw new Error(`${where}.models must map jig's model ids to the provider's.`);
    }
    const base = upstream.baseUrl;
    if (typeof base !== "string" || !/^https?:\/\//.test(base)) throw new Error(`${where}.baseUrl must be an http or https URL.`);
    const names = upstream.keyEnv;
    if (!Array.isArray(names) || !names.length) throw new Error(`${where}.keyEnv must name at least one environment variable holding a key.`);
    const missing = names.filter((name) => !env[name]);
    if (missing.length) throw new Error(`No key in ${missing.join(", ")}.`);
  }
  if (config.metrics !== undefined) {
    const { port, host } = config.metrics ?? {};
    if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new Error("metrics.port must be a port number, 0 to 65535.");
    if (host !== undefined && typeof host !== "string") throw new Error("metrics.host must be a host name or address.");
  }
  // Quotas are each tenant's own: at the top of `limits` they would hold for nobody.
  for (const field of ["dailyUsd", "monthlyUsd"] as const) {
    if ((config.limits as Limits | undefined)?.[field] !== undefined) throw new Error(`limits.${field} is a tenant's quota: set it in limits.tenantDefaults or limits.tenants.`);
    const owners = { tenantDefaults: config.limits?.tenantDefaults, ...Object.fromEntries(Object.entries(config.limits?.tenants ?? {}).map(([id, own]) => [`tenants.${id}`, own])) };
    for (const [name, own] of Object.entries(owners)) {
      const value = own?.[field];
      if (value !== undefined && !(typeof value === "number" && value > 0)) throw new Error(`limits.${name}.${field} must be a number of USD above 0.`);
    }
  }
  for (const field of ["firstByteMs", "idleMs", "failures", "openMs"] as const) {
    const value = config.failover?.[field];
    if (value !== undefined && !(typeof value === "number" && value > 0)) throw new Error(`failover.${field} must be a number above 0.`);
  }
  if (config.state) {
    try {
      parseRedisUrl(config.state.redis);
    } catch (err) {
      throw new Error(`state.redis must be a Redis URL, redis://[:password@]host:port[/db]: ${(err as Error).message}`);
    }
    const { onStateError, leaseMs, prefix } = config.state;
    if (onStateError !== undefined && onStateError !== "closed" && onStateError !== "open") throw new Error('state.onStateError must be "closed" or "open".');
    // A lease that ends as it is taken would turn the concurrency limits off, and a renewal every leaseMs/3
    // must have time to reach Redis.
    if (leaseMs !== undefined && !(Number.isInteger(leaseMs) && leaseMs >= 100)) throw new Error("state.leaseMs must be a whole number of milliseconds, 100 or more.");
    if (prefix !== undefined && typeof prefix !== "string") throw new Error("state.prefix must be a string.");
  }
}

/** An upstream as the gateway keeps it: its address, its keys, the models it serves, and its circuit. */
interface Upstream {
  name: string;
  base: URL;
  pool: KeyPool;
  models?: Record<string, string>;
  breaker: Breaker;
}

/**
 * What sent a request on from an upstream: why, and the reply to give jig if no upstream is left, or none
 * when it gave no reply (it couldn't be reached, or was too slow).
 */
interface Failure {
  upstream: string;
  /** Why, for jig_gateway_failovers_total: connect, timeout, status_<code>, or keys. */
  reason: string;
  why: string;
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: Buffer;
  /** It was the keys that failed it (a 429, or every key resting or refused), not the upstream: its breaker doesn't count it. */
  keys?: boolean;
}

/** A failed reply's body, which is small; undefined past MAX_ERROR_BYTES. */
async function errorBody(reply: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of reply as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_ERROR_BYTES) return void reply.destroy();
    chunks.push(chunk);
  }
  if (!reply.complete) throw new Error("the reply was broken off");
  return Buffer.concat(chunks);
}

/** One model call, as its access line and the metrics tell it. */
interface Call {
  request: string;
  /** When it came, by performance.now(). */
  started: number;
  /** "none" until its token is checked, and for a token that fails. */
  tenant: string;
  task?: string;
  /** The upstream whose reply went back; "none" when none answered. */
  upstream: string;
  /** The provider's id of that reply (its request-id header), to find it in the provider's logs. */
  upstreamRequest?: string;
  usage?: Usage;
  cost?: number;
}

/**
 * Starts a gateway with `config`, its secret and keys read from `env`. `now` is the time a tenant's days
 * and months are counted by, Date.now but in tests.
 */
export async function startGateway(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env, { now = Date.now }: { now?: () => number } = {}): Promise<Gateway> {
  check(config, env);
  const secret = env.JIG_GATEWAY_SECRET!;
  const log = createLog("gateway", { format: logFormat(env), level: logLevel(env) });
  const keyId = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const { firstByteMs = 60_000, idleMs = 120_000, failures = 5, openMs = 30_000 } = config.failover ?? {};
  const upstreams: Upstream[] = (config.upstreams ?? [{ ...config.upstream!, name: "default" }]).map(({ name, baseUrl, keyEnv, models }) => ({
    name,
    base: new URL(baseUrl),
    pool: new KeyPool(keyEnv.map((key) => ({ name: key, value: env[key]!, id: keyId(env[key]!), bad: false, coolUntil: 0, marking: 0, markedAt: 0 }))),
    models,
    breaker: new Breaker(failures, openMs),
  }));
  // This replica's metrics. A label never holds a key, a token, a prompt or a task: tenants, upstreams and
  // statuses are few, tasks are without end.
  const registry = new Registry();
  const metrics = {
    requests: registry.counter("jig_gateway_requests_total", "Model calls by their final status and the upstream whose reply went back (none when none answered).", ["tenant", "upstream", "status"]),
    seconds: registry.histogram("jig_gateway_request_seconds", "From a model call's arrival to its reply's end.", ["upstream"]),
    firstByte: registry.histogram("jig_gateway_first_byte_seconds", "From a model call's arrival to the headers of the provider's reply that it passed back.", ["upstream"]),
    queue: registry.histogram("jig_gateway_queue_seconds", "How long a model call waited for a slot under the limits.", ["tenant"]),
    inflight: registry.gauge("jig_gateway_inflight", "Model calls let through whose reply is not over.", ["tenant"]),
    waiting: registry.gauge("jig_gateway_waiting", "Model calls waiting for a slot on this replica."),
    tokens: registry.counter("jig_gateway_tokens_total", "Tokens the provider counted, by kind: input, output, cache_read, cache_write.", ["tenant", "kind"]),
    cost: registry.counter("jig_gateway_cost_usd_total", "What the priced replies cost, in USD.", ["tenant"]),
    failovers: registry.counter("jig_gateway_failovers_total", "Model calls an upstream failed, by the upstream tried next (none when none was left) and why: connect, timeout, status_<code> or keys.", ["from", "to", "reason"]),
    open: registry.gauge("jig_gateway_upstream_open", "1 while an upstream's circuit is open or half-open.", ["upstream"]),
    keys: registry.gauge("jig_gateway_keys", "Each upstream's keys: ok, resting (rate-limited) or refused.", ["upstream", "state"]),
    refused: registry.counter("jig_gateway_refused_total", "Model calls the gateway turned away itself: auth, budget, rate, concurrency or quota.", ["tenant", "reason"]),
    stateErrors: registry.counter("jig_gateway_state_errors_total", "Reads and writes of the shared state (Redis) that failed."),
  };
  metrics.stateErrors.inc({}, 0);
  const state: State = config.state
    ? new SharedState(new RedisState(config.state.redis, { prefix: config.state.prefix, leaseMs: config.state.leaseMs, now }), {
        onStateError: config.state.onStateError ?? "closed",
        now,
        onError: () => metrics.stateErrors.inc(),
        // Its lines, that Redis went away or came back, go out as the gateway's others do.
        log: (line) => log.warn(line.replace(/^jig gateway: /, "")),
      })
    : new MemoryState({ now });
  const { maxWaitMs = 30_000, tenantDefaults, tenants, ...global } = config.limits ?? {};
  const limiter = new Limiter({ global, tenantDefaults, tenants, maxWaitMs }, state);
  // Gauges are read as a scrape asks for them. The keys' standing is what the replicas share, read afresh.
  metrics.waiting.onCollect(() => metrics.waiting.set({}, limiter.queued));
  metrics.open.onCollect(() => upstreams.forEach(({ name, breaker }) => metrics.open.set({ upstream: name }, breaker.open ? 1 : 0)));
  metrics.keys.onCollect(async () => {
    for (const { name, pool } of upstreams) {
      await pool.refresh(state);
      const now = Date.now();
      const counts = { ok: 0, resting: 0, refused: 0 };
      for (const key of pool.keys) counts[key.bad ? "refused" : key.coolUntil > now ? "resting" : "ok"]++;
      for (const [standing, n] of Object.entries(counts)) metrics.keys.set({ upstream: name, state: standing }, n);
    }
  });
  const admin = config.adminTokenEnv ? env[config.adminTokenEnv] : undefined;

  const isAdmin = (given: string): boolean => {
    if (!admin || !given) return false;
    const digest = (text: string) => createHash("sha256").update(text).digest();
    return timingSafeEqual(digest(given), digest(admin));
  };

  /**
   * Counts a reply's usage toward its task and tenant, and the upstream that gave it, priced by the model
   * the reply names, or the one the upstream was asked for, or else the one jig asked for.
   */
  const meter = async (call: Call, token: TokenPayload, requested: string | undefined, provided: string | undefined, reader: UsageReader, upstream: string): Promise<void> => {
    const model = [reader.model, provided].find((id) => id && PRICES[id]) ?? requested;
    const cost = model ? costOf(model, reader.usage) : undefined;
    for (const [kind, n] of Object.entries(reader.usage)) if (n) metrics.tokens.inc({ tenant: token.tenant, kind: TOKEN_KINDS[kind as keyof Usage] }, n);
    if (cost) metrics.cost.inc({ tenant: token.tenant }, cost);
    call.usage = reader.usage;
    call.cost = cost;
    // Without Redis ("closed"), what the reply cost goes uncounted: it is counted as a state error and said.
    await state.spend(token, reader.usage, cost, upstream).catch(() => {});
  };

  /**
   * The quota `tenant` has spent, of `dailyUsd` and `monthlyUsd`, with the seconds until it resets, at 00:00
   * UTC of the next day or month; the month's when both are, as it resets last. Undefined while neither is.
   */
  const spentQuota = async (tenant: string, dailyUsd: number | undefined, monthlyUsd: number | undefined) => {
    const time = now();
    const day = utcDay(time);
    const [year, month, date] = day.split("-").map(Number);
    const quotas = [
      { which: "monthly", quotaUsd: monthlyUsd, read: () => state.spentIn(tenant, day.slice(0, 7)), resets: Date.UTC(year, month, 1), when: "this month" },
      { which: "daily", quotaUsd: dailyUsd, read: () => state.spentOn(tenant, day), resets: Date.UTC(year, month - 1, date + 1), when: "today" },
    ];
    for (const { which, quotaUsd, read, resets, when } of quotas) {
      if (quotaUsd === undefined) continue;
      const spentUsd = (await read())?.costUsd ?? 0;
      if (spentUsd >= quotaUsd) return { which, quotaUsd, spentUsd, when, resets, retryAfter: Math.max(1, Math.ceil((resets - time) / 1000)) };
    }
    return undefined;
  };

  /** One request to the provider at `base` with `key`; resolves with its reply's status and headers. */
  const send = (base: URL, path: string, headers: IncomingHttpHeaders, body: Buffer, key: Key, signal: AbortSignal): Promise<IncomingMessage> =>
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
   * Sends the request to `upstream` with a key from its pool. A key the provider refuses is marked bad and
   * one it rate-limits cools down; either way the request goes once to each other usable key. Answers the
   * reply to pass back, or the failure that sends the request on: no reply's headers within firstByteMs, a
   * server error or overload, a rate limit with no key left to try, or every key refused.
   */
  const attempt = async (upstream: Upstream, path: string, headers: IncomingHttpHeaders, body: Buffer, signal: AbortSignal): Promise<IncomingMessage | Failure> => {
    const { name, base, pool } = upstream;
    const failure = (reason: string, status: number, type: string, message: string, headers: Record<string, string> = {}): Failure => ({
      upstream: name,
      reason,
      why: message,
      status,
      headers: { "content-type": "application/json", ...headers },
      body: Buffer.from(JSON.stringify({ type: "error", error: { type, message } })),
    });
    const tried = new Set<Key>();
    await pool.refresh(state);
    for (;;) {
      const key = pool.take(tried);
      if (!key) {
        const retryAfter = pool.retryAfter();
        if (retryAfter === undefined) return { ...failure("keys", 502, "api_error", "The gateway's provider keys were all refused; an operator must replace them."), keys: true };
        return { ...failure("keys", 429, "rate_limit_error", "Every provider key is rate-limited; try again later.", { "retry-after": String(retryAfter) }), keys: true };
      }
      tried.add(key);
      // The reply's headers, and a failed reply's body, must come in time.
      const slow = new AbortController();
      const timer = setTimeout(() => slow.abort(), firstByteMs);
      try {
        let reply: IncomingMessage;
        try {
          reply = await send(base, path, headers, body, key, AbortSignal.any([signal, slow.signal]));
        } catch (err) {
          // Never counted: forward sees that jig went away first.
          if (signal.aborted) return { upstream: name, reason: "connect", why: "jig went away" };
          if (slow.signal.aborted) return { upstream: name, reason: "timeout", why: `no reply from ${base.host} within ${firstByteMs} ms` };
          return { upstream: name, reason: "connect", why: `could not reach ${base.host}: ${(err as Error).message}` };
        }
        const status = reply.statusCode ?? 502;
        const refused = status === 401 || status === 403;
        if (refused) pool.mark(state, key, "bad");
        if (status === 429) pool.mark(state, key, Date.now() + retryAfterMs(reply.headers["retry-after"]));
        if ((refused || status === 429) && pool.take(tried, true)) {
          reply.resume();
          continue;
        }
        if (refused) {
          reply.resume();
          return { ...failure("keys", 502, "api_error", `The provider refused the gateway's key (${status}); an operator must replace it.`), keys: true };
        }
        if (!FAILOVER_STATUSES.has(status)) return reply;
        const keys = status === 429;
        const reason = `status_${status}`;
        try {
          const failed = await errorBody(reply);
          if (!failed) return { ...failure(reason, status, "api_error", `${status} from ${base.host}, with a body too large to pass on.`), keys };
          return { upstream: name, reason, why: `${status} from ${base.host}`, status, headers: reply.headers, body: failed, keys };
        } catch (err) {
          if (slow.signal.aborted) return { upstream: name, reason: "timeout", why: `no reply from ${base.host} within ${firstByteMs} ms` };
          return { upstream: name, reason, why: `${status} from ${base.host}, ${(err as Error).message}` };
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };

  /**
   * Tries the upstreams that serve the request's model in order, passing over any whose circuit is open,
   * until one gives a reply to pass back, and passes it back as it comes. A request goes on to the next
   * upstream only before anything of the reply has gone to jig: once it streams, a break is jig's to retry,
   * since the gateway can't take back what jig has seen. With none left, the last failed reply goes back as
   * it came (a rate limit with its retry-after, which jig's SDK waits: no storm of retries from here), or
   * 503 when none answered.
   */
  const forward = async (req: IncomingMessage, res: ServerResponse, call: Call, token: TokenPayload, body: Buffer, model: string | undefined, serving: Upstream[], signal: AbortSignal): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const path = url.pathname.replace(/^\/anthropic/, "") + url.search;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name) && !SET_HERE.has(name)));
    const { request } = call;
    let last: Failure | undefined;
    const why: string[] = [];
    let opensIn = Infinity;
    // An upstream's failure is counted once the next one is tried, or none is left.
    let failedOver: { from: string; reason: string } | undefined;
    for (const upstream of serving) {
      const { name, breaker } = upstream;
      const taken = breaker.take();
      if (!taken) {
        opensIn = Math.min(opensIn, breaker.wait());
        why.push(`${name}: passed over while its circuit is open`);
        continue;
      }
      if (failedOver) metrics.failovers.inc({ ...failedOver, to: name });
      failedOver = undefined;
      const provided = model === undefined ? undefined : upstream.models?.[model];
      let settled = false;
      try {
        const outcome = await attempt(upstream, path, headers, provided && provided !== model ? withModel(body, provided) : body, signal);
        if (signal.aborted) {
          if (!("why" in outcome)) outcome.destroy(); // jig went away while the provider answered
          return;
        }
        settled = true;
        if ("why" in outcome) {
          failedOver = { from: name, reason: outcome.reason };
          if (outcome.keys) breaker.abandoned(taken);
          else if (breaker.failed(taken)) log.warn(`upstream ${name} is passed over for ${openMs} ms`, { upstream: name, why: outcome.why, request });
          if (outcome.status) last = outcome;
          why.push(`${name}: ${outcome.why}`);
          continue;
        }
        if (breaker.succeeded()) log.info(`upstream ${name} answers again`, { upstream: name, request });
        return await pass(res, outcome, call, token, model, provided, name);
      } finally {
        if (!settled) breaker.abandoned(taken);
      }
    }
    if (failedOver) metrics.failovers.inc({ ...failedOver, to: "none" });
    if (last) {
      call.upstream = last.upstream;
      const id = last.headers?.["request-id"];
      if (typeof id === "string") call.upstreamRequest = id;
      res.writeHead(last.status!, { ...Object.fromEntries(Object.entries(last.headers ?? {}).filter(([name]) => !HOP_BY_HOP.has(name))), "x-jig-upstream": last.upstream });
      return void res.end(last.body);
    }
    const retryAfter: Record<string, string> = Number.isFinite(opensIn) ? { "retry-after": String(Math.max(1, Math.ceil(opensIn / 1000))) } : {};
    fail(res, 503, "overloaded_error", `No upstream that serves ${model ?? "the request"} answered: ${why.join("; ")}.`, retryAfter);
  };

  /** Passes `reply` back to jig as it comes, counting its usage on the way. */
  const pass = async (res: ServerResponse, reply: IncomingMessage, call: Call, token: TokenPayload, model: string | undefined, provided: string | undefined, upstream: string): Promise<void> => {
    const status = reply.statusCode ?? 502;
    call.upstream = upstream;
    const id = reply.headers["request-id"];
    if (typeof id === "string") call.upstreamRequest = id;
    metrics.firstByte.observe({ upstream }, (performance.now() - call.started) / 1000);
    const reader = new UsageReader(/event-stream/.test(String(reply.headers["content-type"])));
    res.writeHead(status, { ...Object.fromEntries(Object.entries(reply.headers).filter(([name]) => !HOP_BY_HOP.has(name))), "x-jig-upstream": upstream });
    res.flushHeaders();
    // A provider that stops sending on a live connection would hold the request and its slot for as long as
    // jig waits, which for a client with no timeout of its own is forever. A stream's pings keep it going.
    reply.setTimeout(idleMs, () => reply.destroy(new Error(`no data from upstream for ${idleMs} ms`)));
    reply.on("data", (chunk: Buffer) => reader.add(chunk));
    // Counted however the reply ends: tokens the provider sent before jig went away were spent too.
    let counted: Promise<void> | undefined;
    const count = () => (counted ??= (reader.end(), status === 200 ? meter(call, token, model, provided, reader, upstream) : Promise.resolve()));
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
  };

  const messages = async (req: IncomingMessage, res: ServerResponse, call: Call): Promise<void> => {
    const token = verifyToken(secret, credential(req.headers));
    if (token instanceof Error) {
      // Whose it claims to be is not known, and a label of it would let anyone make series without end.
      metrics.refused.inc({ tenant: "none", reason: "auth" });
      return fail(res, 401, "authentication_error", `Not a valid gateway token: ${token.message}.`);
    }
    call.tenant = token.tenant;
    call.task = token.task;
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
    const serving = upstreams.filter((upstream) => !upstream.models || (model !== undefined && Object.hasOwn(upstream.models, model)));
    if (!serving.length) return fail(res, 400, "invalid_request_error", `No upstream of the gateway serves the model ${model ?? "(none named)"}.`);
    if (token.budgetUsd !== null) {
      // Nothing spent yet is $0, so a budget of 0 refuses the first request too.
      const spentUsd = (await state.spent(token.tenant, token.task))?.costUsd ?? 0;
      if (spentUsd >= token.budgetUsd) {
        metrics.refused.inc({ tenant: token.tenant, reason: "budget" });
        return fail(res, 402, "billing_error", `This task has spent its budget: $${usd(spentUsd)} of $${usd(token.budgetUsd)}.`);
      }
      // A budget the gateway can't price toward would not hold.
      if (!model || !PRICES[model]) {
        return fail(res, 400, "invalid_request_error", `A task with a budget can only use a model with a price (${Object.keys(PRICES).join(", ")}).`);
      }
    }
    // The tenant's quotas, before its request waits for a slot. Replies still going are counted when they
    // end, so a tenant can go past a quota by what they cost.
    const { dailyUsd, monthlyUsd } = limiter.tenantLimits(token.tenant);
    if (dailyUsd !== undefined || monthlyUsd !== undefined) {
      const spent = await spentQuota(token.tenant, dailyUsd, monthlyUsd);
      if (spent) {
        metrics.refused.inc({ tenant: token.tenant, reason: "quota" });
        const { which, spentUsd, quotaUsd, when, resets, retryAfter } = spent;
        const message = `This tenant has spent its ${which} quota: $${usd(spentUsd)} of $${usd(quotaUsd)} ${when} (UTC). It resets at ${new Date(resets).toISOString().replace(".000Z", "Z")}.`;
        return fail(res, 402, "billing_error", message, { "retry-after": String(retryAfter) });
      }
      // As with a budget, a quota holds only where the gateway can price the reply.
      if (!model || !PRICES[model]) {
        return fail(res, 400, "invalid_request_error", `A tenant with a quota can only use a model with a price (${Object.keys(PRICES).join(", ")}).`);
      }
    }
    const client = new AbortController();
    res.once("close", () => res.writableFinished || client.abort()); // jig went away: so does the request
    const queued = performance.now();
    const admission: Admission = await limiter.acquire(token.tenant, client.signal);
    if (!client.signal.aborted) metrics.queue.observe({ tenant: token.tenant }, (performance.now() - queued) / 1000);
    if ("retryAfter" in admission) {
      if (client.signal.aborted) return;
      if (admission.error) throw admission.error;
      if (admission.limit) metrics.refused.inc({ tenant: token.tenant, reason: admission.limit });
      return fail(res, 429, "rate_limit_error", "This tenant's requests are over its limits; try again later.", { "retry-after": String(admission.retryAfter) });
    }
    metrics.inflight.inc({ tenant: token.tenant });
    try {
      await forward(req, res, call, token, body, model, serving, client.signal);
    } finally {
      admission.release();
      metrics.inflight.dec({ tenant: token.tenant });
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
    const nothing: Spent | undefined = token instanceof Error ? undefined : { tenant, requests: 0, usage: { ...NO_USAGE }, costUsd: 0, unpriced: 0, upstreams: {}, budgetUsd: token.budgetUsd };
    const found = (await state.spent(tenant, task)) ?? nothing;
    if (!found) return fail(res, 404, "not_found_error", `No usage for task ${task} of ${tenant}.`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ task, ...found }));
  };

  /**
   * A tenant's spending by UTC day, for billing, to the admin token: /usage?tenant=<id>&from=<day>&to=<day>,
   * both days in, a year's at most. Days with nothing spent are left out.
   */
  const usageByDay = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const given = credential(req.headers);
    if (!isAdmin(given)) {
      if (verifyToken(secret, given) instanceof Error) return fail(res, 401, "authentication_error", "A tenant's usage takes the admin token.");
      return fail(res, 403, "permission_error", "A task's token reads only its own usage, at /usage/<task>.");
    }
    const [tenant, from, to] = ["tenant", "from", "to"].map((name) => url.searchParams.get(name) ?? "");
    if (!tenant) return fail(res, 400, "invalid_request_error", "Name the tenant: /usage?tenant=<tenant>&from=YYYY-MM-DD&to=YYYY-MM-DD.");
    const [start, end] = [dayStart(from), dayStart(to)];
    if (start === undefined || end === undefined) return fail(res, 400, "invalid_request_error", "from and to must be days, as YYYY-MM-DD.");
    const count = (end - start) / DAY_MS + 1;
    if (count < 1) return fail(res, 400, "invalid_request_error", "from must not be after to.");
    if (count > MAX_USAGE_DAYS) return fail(res, 400, "invalid_request_error", `A range is ${MAX_USAGE_DAYS} days at most.`);
    const days = Array.from({ length: count }, (_, i) => utcDay(start + i * DAY_MS));
    const spent = await Promise.all(days.map((day) => state.spentOn(tenant, day)));
    const total = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
    const listed = days.flatMap((day, i) => {
      const found = spent[i];
      if (!found) return [];
      const { requests, usage, costUsd } = found;
      const counts = { requests, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd };
      for (const field of Object.keys(total) as (keyof typeof total)[]) total[field] += counts[field];
      return [{ day, ...counts }];
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ tenant, from, to, days: listed, total }));
  };

  /** Counts a model call once its reply is over, however it ended, and writes its access line. */
  const record = (call: Call, res: ServerResponse): void => {
    // 499, as nginx has it, when jig went away before any reply.
    const status = res.headersSent ? res.statusCode : 499;
    const seconds = (performance.now() - call.started) / 1000;
    const { request, tenant, task, upstream, usage, cost, upstreamRequest } = call;
    metrics.requests.inc({ tenant, upstream, status });
    metrics.seconds.observe({ upstream }, seconds);
    const ms = Math.round(seconds * 1000);
    log.debug("model call", { request, tenant, task, upstream, status, ms, input: usage?.input, output: usage?.output, cost, upstream_request: upstreamRequest });
  };

  const route = async (req: IncomingMessage, res: ServerResponse, request: string): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const { pathname } = url;
    const route = `${req.method} ${pathname}`;
    if (route === "POST /anthropic/v1/messages") {
      const call: Call = { request, started: performance.now(), tenant: "none", upstream: "none" };
      res.once("close", () => record(call, res));
      return messages(req, res, call);
    }
    if (route === "GET /healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    if (route === "GET /usage") return usageByDay(req, res, url);
    if (req.method === "GET" && pathname.startsWith("/usage/")) return usage(req, res, url);
    fail(res, 404, "not_found_error", `The gateway has no ${route}.`);
  };

  const server = createServer((req, res) => {
    const request = requestId(req);
    res.setHeader("x-request-id", request);
    route(req, res, request).catch((err) => {
      if (err instanceof StateError) return fail(res, 503, "api_error", `${err.message}; try again shortly.`, { "retry-after": "1" });
      log.error("a request failed", { request, err });
      fail(res, 500, "api_error", `The gateway failed: ${(err as Error).message}`);
    });
  });
  // The metrics on a listener of their own, never the port the tasks reach, as they need no token.
  const scrape = config.metrics && createServer((req, res) => {
    res.setHeader("x-request-id", requestId(req));
    // A throw here is uncaught and would end the process, so a target that is no URL is answered 400.
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://gateway").pathname;
    } catch {
      return fail(res, 400, "invalid_request_error", "The request's target is not a URL path.");
    }
    const route = `${req.method} ${pathname}`;
    if (route === "GET /metrics") return void registry.serve(res).catch((err) => fail(res, 500, "api_error", `The metrics failed: ${(err as Error).message}`));
    if (route === "GET /healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    fail(res, 404, "not_found_error", `The gateway's metrics listener has no ${route}.`);
  });
  const listen = async (server: Server, host: string, port: number): Promise<string> => {
    await new Promise<void>((done, failed) => server.once("error", failed).listen(port, host, done));
    const address = server.address() as AddressInfo;
    return `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  };
  const { host = "127.0.0.1", port = 8787 } = config.listen ?? {};
  let url: string;
  let metricsUrl: string | undefined;
  try {
    url = await listen(server, host, port);
    if (scrape) metricsUrl = await listen(scrape, config.metrics!.host ?? "127.0.0.1", config.metrics!.port);
  } catch (err) {
    // The Limiter has already subscribed to Redis: left open, that connection would keep the process of a
    // program that started the gateway, and goes on without it, from ever ending.
    limiter.close();
    server.close();
    scrape?.close();
    state.close();
    throw err;
  }
  return {
    url,
    metricsUrl,
    async close() {
      limiter.close();
      for (const listener of [server, scrape]) listener?.closeAllConnections();
      await Promise.all([server, scrape].map((listener) => listener && new Promise((done) => listener.close(done))));
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
  const log = createLog("gateway");
  let gateway: Gateway;
  try {
    gateway = await startGateway(JSON.parse(readFileSync(values.config, "utf8")));
  } catch (err) {
    log.error("could not start", { err });
    process.exit(1);
  }
  log.info(`listening on ${gateway.url}`, { metrics: gateway.metricsUrl });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => gateway.close().then(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
