// What the gateway counts and must agree on: requests in flight and the rate buckets (admission), what
// each task and tenant spent, and which provider keys are refused or resting. MemoryState keeps it in
// this process, as one gateway needs; RedisState keeps it in Redis, so several replicas act as one gateway
// and a restart forgets nothing; SharedState puts RedisState behind the gateway's choice of what to do
// when Redis can't be reached. docs/server.md describes it.

import type { Usage } from "../src/agent.ts";
import type { Limits } from "./limits.ts";
import { Redis, type RedisReply, redisScript } from "./redis.ts";
import type { TokenPayload } from "./token.ts";

/** What a task, or a tenant in a day, spent. */
export interface Spent {
  tenant: string;
  /** Replies counted. */
  requests: number;
  usage: Usage;
  costUsd: number;
  /** Requests whose model has no price in src/prices.ts: their tokens count, their cost doesn't. */
  unpriced: number;
  /** The task's budget, as its token gave it; null for none, and for a tenant. */
  budgetUsd: number | null;
}

/** A provider key's standing, by the key's hash: refused for good, or resting until a time. */
export interface KeyState {
  bad: boolean;
  coolUntil: number;
}

export interface State {
  /**
   * Takes a slot for request `id` of `tenant` if the limits allow it now, and answers 0; otherwise the
   * milliseconds until a bucket has room, or Infinity until a request in flight ends.
   */
  admit(tenant: string, id: string, limits: { tenant: Limits; global: Limits }): Promise<number>;
  /** Gives back a slot that admit took. */
  release(tenant: string, id: string): Promise<void>;
  /** How long a slot is held without a renewal; undefined where a slot can't be left behind (one process). */
  readonly leaseMs?: number;
  /** Keeps a slot of a request still going from expiring. */
  renew(tenant: string, id: string): Promise<void>;
  /** Calls `listener` when another gateway gives back a slot. */
  onRelease(listener: () => void): void;
  /** Adds a reply's usage to its task's and its tenant's day's totals; `cost` undefined for an unpriced model. */
  spend(token: TokenPayload, usage: Usage, cost: number | undefined): Promise<void>;
  /** What `tenant`'s task `task` spent; undefined if nothing yet. */
  spent(tenant: string, task: string): Promise<Spent | undefined>;
  /** What `tenant` spent on a UTC day (YYYY-MM-DD), for quotas and billing to read. */
  spentOn(tenant: string, day: string): Promise<Spent | undefined>;
  /**
   * The keys' standing, shared with other gateways; undefined when it can't be read. One process needs none
   * beyond its own.
   */
  keys?(ids: string[]): Promise<KeyState[] | undefined>;
  markKey?(id: string, state: "bad" | number): Promise<void>;
  close(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a tenant's days are kept: a month's bill can be read from them. */
const DAYS_KEPT = 35;

const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const USAGE_FIELDS = Object.keys(NO_USAGE) as (keyof Usage)[];

/** The UTC day of `ms`, as YYYY-MM-DD. */
export function utcDay(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function nothingSpent(tenant: string, budgetUsd: number | null): Spent {
  return { tenant, requests: 0, usage: { ...NO_USAGE }, costUsd: 0, unpriced: 0, budgetUsd };
}

function addTo(total: Spent, usage: Usage, cost: number | undefined): void {
  total.requests++;
  for (const field of USAGE_FIELDS) total.usage[field] += usage[field];
  if (cost === undefined) total.unpriced++;
  else total.costUsd += cost;
}

/** A token bucket: `perMinute` refilled continuously, holding `burst` (by default a minute's worth). */
export class Bucket {
  private tokens: number;
  private last: number;
  private readonly perMs: number;
  private readonly capacity: number;

  constructor(perMinute: number, burst: number | undefined, now: number) {
    this.perMs = perMinute / 60_000;
    this.capacity = Math.max(1, burst ?? perMinute);
    this.tokens = this.capacity;
    this.last = now;
  }

  /** Milliseconds until a request can be taken, 0 if now. */
  wait(now: number): number {
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
    this.last = now;
    return this.tokens >= 1 ? 0 : (1 - this.tokens) / this.perMs;
  }

  take(now: number): void {
    this.wait(now);
    this.tokens -= 1;
  }

  /** Full again, so no different from a new one. */
  full(now: number): boolean {
    this.wait(now);
    return this.tokens >= this.capacity;
  }
}

/** The state in this process: one gateway's, or a replica's own while Redis can't be reached. */
export class MemoryState implements State {
  private readonly buckets = new Map<string, Bucket | undefined>();
  private globalBucket?: Bucket;
  private readonly flying = new Map<string, number>();
  private total = 0;
  private readonly tasks = new Map<string, Spent & { until: number }>();
  private readonly days = new Map<string, Spent & { until: number }>();
  private readonly sweeper = setInterval(() => this.prune(), 60_000).unref();

  async admit(tenant: string, _id: string, limits: { tenant: Limits; global: Limits }): Promise<number> {
    const now = Date.now();
    if (this.total >= (limits.global.concurrent ?? Infinity)) return Infinity;
    if ((this.flying.get(tenant) ?? 0) >= (limits.tenant.concurrent ?? Infinity)) return Infinity;
    if (limits.global.requestsPerMinute && !this.globalBucket) this.globalBucket = new Bucket(limits.global.requestsPerMinute, limits.global.burst, now);
    if (!this.buckets.has(tenant)) {
      const { requestsPerMinute, burst } = limits.tenant;
      this.buckets.set(tenant, requestsPerMinute ? new Bucket(requestsPerMinute, burst, now) : undefined);
    }
    const bucket = this.buckets.get(tenant);
    const wait = Math.max(this.globalBucket?.wait(now) ?? 0, bucket?.wait(now) ?? 0);
    if (wait > 0) return wait;
    this.globalBucket?.take(now);
    bucket?.take(now);
    this.total++;
    this.flying.set(tenant, (this.flying.get(tenant) ?? 0) + 1);
    return 0;
  }

  async release(tenant: string): Promise<void> {
    this.total--;
    const left = (this.flying.get(tenant) ?? 1) - 1;
    if (left > 0) this.flying.set(tenant, left);
    else this.flying.delete(tenant);
  }

  async renew(): Promise<void> {}

  onRelease(): void {}

  async spend(token: TokenPayload, usage: Usage, cost: number | undefined): Promise<void> {
    const now = Date.now();
    const task = JSON.stringify([token.tenant, token.task]);
    if (!this.tasks.has(task)) this.tasks.set(task, { ...nothingSpent(token.tenant, token.budgetUsd), until: 0 });
    const day = JSON.stringify([token.tenant, utcDay(now)]);
    if (!this.days.has(day)) this.days.set(day, { ...nothingSpent(token.tenant, null), until: now + DAYS_KEPT * DAY_MS });
    const spent = this.tasks.get(task)!;
    // Kept a day past the token's end, by when no request of the task can come.
    spent.until = Math.max(spent.until, token.exp * 1000 + DAY_MS);
    addTo(spent, usage, cost);
    addTo(this.days.get(day)!, usage, cost);
  }

  async spent(tenant: string, task: string): Promise<Spent | undefined> {
    return this.copy(this.tasks.get(JSON.stringify([tenant, task])));
  }

  async spentOn(tenant: string, day: string): Promise<Spent | undefined> {
    return this.copy(this.days.get(JSON.stringify([tenant, day])));
  }

  /** Forgets tasks a day past their token, old days, and tenants' full buckets, so the maps don't grow forever. */
  prune(now = Date.now()): void {
    for (const map of [this.tasks, this.days]) for (const [key, spent] of map) if (spent.until <= now) map.delete(key);
    for (const [tenant, bucket] of this.buckets) if (!bucket || bucket.full(now)) this.buckets.delete(tenant);
  }

  /** How many entries it holds, for the tests to see it pruned. */
  get size(): number {
    return this.tasks.size + this.days.size + this.buckets.size + this.flying.size;
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private copy(spent: (Spent & { until: number }) | undefined): Spent | undefined {
    if (!spent) return undefined;
    const { until: _, ...rest } = spent;
    return { ...rest, usage: { ...rest.usage } };
  }
}

// Each check and change is one script, so two gateways never both take the last slot. The time is Redis's
// own, so the replicas' clocks needn't agree.
const NOW = `local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

/**
 * KEYS: the global and the tenant's leases (ZSETs of request ids by expiry), the global and the tenant's
 * buckets (hashes). ARGV: the id, leaseMs, then the global and the tenant's concurrent, requestsPerMinute
 * and burst, -1 for none. Answers 0 with the slot taken, -1 while a concurrency limit is reached, or the
 * milliseconds until a bucket has room.
 */
const ADMIT = redisScript(`${NOW}
local id, lease = ARGV[1], tonumber(ARGV[2])
for i = 1, 2 do
  local limit = tonumber(ARGV[2 + i * 3 - 2])
  if limit >= 0 then
    redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
    if redis.call('ZCARD', KEYS[i]) >= limit then return -1 end
  end
end
local levels, wait = {}, 0
for i = 1, 2 do
  local perMinute, burst = tonumber(ARGV[2 + i * 3 - 1]), tonumber(ARGV[2 + i * 3])
  if perMinute > 0 then
    local capacity = math.max(1, burst >= 0 and burst or perMinute)
    local bucket = redis.call('HMGET', KEYS[2 + i], 'tokens', 'last')
    local tokens = tonumber(bucket[1]) or capacity
    tokens = math.min(capacity, tokens + math.max(0, now - (tonumber(bucket[2]) or now)) * perMinute / 60000)
    levels[i] = { tokens, math.ceil(capacity * 60000 / perMinute) + 1000 }
    if tokens < 1 then wait = math.max(wait, math.ceil((1 - tokens) * 60000 / perMinute)) end
  end
end
if wait > 0 then return wait end
for i = 1, 2 do
  if levels[i] then
    redis.call('HSET', KEYS[2 + i], 'tokens', tostring(levels[i][1] - 1), 'last', now)
    -- Gone once it would be full again, which is the same as a new one.
    redis.call('PEXPIRE', KEYS[2 + i], levels[i][2])
  end
  if tonumber(ARGV[2 + i * 3 - 2]) >= 0 then
    redis.call('ZADD', KEYS[i], now + lease, id)
    redis.call('PEXPIRE', KEYS[i], lease * 2)
  end
end
return 0`);

/** KEYS: the leases. ARGV: the id, leaseMs. Moves the lease's expiry on, where it is still held. */
const RENEW = redisScript(`${NOW}
for _, key in ipairs(KEYS) do
  if redis.call('ZADD', key, 'XX', 'CH', now + tonumber(ARGV[2]), ARGV[1]) == 1 then redis.call('PEXPIRE', key, tonumber(ARGV[2]) * 2) end
end
return 0`);

/**
 * KEYS: the task's and the tenant's day's hashes. ARGV: input, cacheRead, cacheWrite, output, the cost
 * ('' when unpriced), each key's expiry (Unix seconds), the tenant, the task's budget ('' for none).
 */
const SPEND = redisScript(`local fields = { 'input', 'cacheRead', 'cacheWrite', 'output' }
for i, key in ipairs(KEYS) do
  redis.call('HINCRBY', key, 'requests', 1)
  for j, field in ipairs(fields) do redis.call('HINCRBY', key, field, ARGV[j]) end
  if ARGV[5] == '' then redis.call('HINCRBY', key, 'unpriced', 1) else redis.call('HINCRBYFLOAT', key, 'costUsd', ARGV[5]) end
  redis.call('HSET', key, 'tenant', ARGV[8])
  redis.call('EXPIREAT', key, ARGV[5 + i])
end
redis.call('HSET', KEYS[1], 'budgetUsd', ARGV[9])
return 0`);

/** How long a refused key's mark is kept after it was last refused: a key an operator put right is tried again by then. */
const BAD_KEY_SECONDS = 86_400;

/**
 * KEYS: the key's mark. ARGV: 'bad' or the time it rests until, then the milliseconds until that time.
 * Each key's mark expires on its own: a refused one a day after it was last refused, a resting one when
 * its rest is over. A rest doesn't undo a refusal.
 */
const MARK_KEY = redisScript(`if ARGV[1] == 'bad' then
  redis.call('SET', KEYS[1], 'bad', 'EX', ${BAD_KEY_SECONDS})
  return 0
end
local was = redis.call('GET', KEYS[1])
if was ~= 'bad' and (not was or tonumber(was) < tonumber(ARGV[1])) then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) end
return 0`);

export interface RedisStateOptions {
  /** Put before every key and the channel, so several gateways can share a Redis (default: "jig:gw:"). */
  prefix?: string;
  /** How long a request's slot is held without a renewal (default: 60 seconds). */
  leaseMs?: number;
  /** How long a command may wait for Redis (default: 2 seconds). */
  timeoutMs?: number;
}

/** The state in Redis, shared by every gateway that uses the same URL and prefix. */
export class RedisState implements State {
  readonly leaseMs: number;
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly prefix: string;
  private readonly listeners: (() => void)[] = [];

  constructor(url: string, options: RedisStateOptions = {}) {
    this.prefix = options.prefix ?? "jig:gw:";
    this.leaseMs = options.leaseMs ?? 60_000;
    this.redis = new Redis(url, { timeoutMs: options.timeoutMs });
    this.subscriber = new Redis(url, { timeoutMs: options.timeoutMs, onMessage: () => this.listeners.forEach((listener) => listener()) });
  }

  /** A key's name: the prefix, then each part encoded, so no tenant or task id can pass for another. */
  private key(...parts: string[]): string {
    return this.prefix + parts.map(encodeURIComponent).join(":");
  }

  private leases(tenant: string): string[] {
    return [this.key("inflight"), this.key("inflight", tenant)];
  }

  async admit(tenant: string, id: string, limits: { tenant: Limits; global: Limits }): Promise<number> {
    const args = [limits.global, limits.tenant].flatMap(({ concurrent, requestsPerMinute, burst }) => [concurrent ?? -1, requestsPerMinute ?? -1, burst ?? -1]);
    const wait = Number(await this.redis.eval(ADMIT, [...this.leases(tenant), this.key("rate"), this.key("rate", tenant)], [id, this.leaseMs, ...args]));
    return wait < 0 ? Infinity : wait;
  }

  async release(tenant: string, id: string): Promise<void> {
    await Promise.all([...this.leases(tenant).map((key) => this.redis.command(["ZREM", key, id])), this.redis.command(["PUBLISH", this.key("released"), tenant])]);
  }

  async renew(tenant: string, id: string): Promise<void> {
    await this.redis.eval(RENEW, this.leases(tenant), [id, this.leaseMs]);
  }

  onRelease(listener: () => void): void {
    this.listeners.push(listener);
    void this.subscriber.subscribe(this.key("released")).catch(() => {}); // it subscribes again when Redis is back
  }

  async spend(token: TokenPayload, usage: Usage, cost: number | undefined): Promise<void> {
    const now = Date.now();
    // A task's spending is kept a week past its token: its budget holds as long as the token works.
    const taskUntil = token.exp + 7 * 86_400;
    const dayUntil = Math.floor(now / 1000) + DAYS_KEPT * 86_400;
    const keys = [this.key("spent", token.tenant, token.task), this.key("day", token.tenant, utcDay(now))];
    const args = [...USAGE_FIELDS.map((field) => usage[field]), cost === undefined ? "" : cost, taskUntil, dayUntil, token.tenant, token.budgetUsd ?? ""];
    await this.redis.eval(SPEND, keys, args);
  }

  async spent(tenant: string, task: string): Promise<Spent | undefined> {
    return this.read(this.key("spent", tenant, task), tenant);
  }

  async spentOn(tenant: string, day: string): Promise<Spent | undefined> {
    return this.read(this.key("day", tenant, day), tenant);
  }

  async keys(ids: string[]): Promise<KeyState[]> {
    const states = (await this.redis.command(["MGET", ...ids.map((id) => this.key("key", id))])) as RedisReply[];
    return states.map((state) => ({ bad: state === "bad", coolUntil: state === "bad" ? 0 : Number(state ?? 0) }));
  }

  async markKey(id: string, state: "bad" | number): Promise<void> {
    const args = state === "bad" ? [state, 0] : [Math.ceil(state), Math.max(1, Math.ceil(state - Date.now()))];
    await this.redis.eval(MARK_KEY, [this.key("key", id)], args);
  }

  close(): void {
    this.redis.close();
    this.subscriber.close();
  }

  private async read(key: string, tenant: string): Promise<Spent | undefined> {
    const reply = (await this.redis.command(["HGETALL", key])) as string[];
    if (!reply.length) return undefined;
    const fields: Record<string, string> = {};
    for (let i = 0; i < reply.length; i += 2) fields[reply[i]] = reply[i + 1];
    const number = (field: string) => Number(fields[field] ?? 0);
    return {
      tenant,
      requests: number("requests"),
      usage: Object.fromEntries(USAGE_FIELDS.map((field) => [field, number(field)])) as unknown as Usage,
      costUsd: number("costUsd"),
      unpriced: number("unpriced"),
      budgetUsd: fields.budgetUsd ? Number(fields.budgetUsd) : null,
    };
  }
}

/** Redis couldn't be reached and the gateway is to refuse requests: 503, with a time to try again. */
export class StateError extends Error {
  override name = "StateError";
}

/**
 * RedisState, with what to do when Redis can't be reached: "closed" refuses (a StateError, which the
 * gateway answers with 503), "open" uses this replica's own MemoryState until Redis is back. Either way the
 * error is counted, and said once each time Redis goes away.
 */
export class SharedState implements State {
  readonly leaseMs: number;
  private readonly redis: RedisState;
  private readonly fallback?: MemoryState;
  private readonly onError: (err: Error) => void;
  private readonly log: (line: string) => void;
  /** Slots the fallback gave, which go back to it. */
  private readonly local = new Set<string>();
  private down = false;

  constructor(redis: RedisState, options: { onStateError: "closed" | "open"; onError(err: Error): void; log?(line: string): void }) {
    this.redis = redis;
    this.leaseMs = redis.leaseMs;
    if (options.onStateError === "open") this.fallback = new MemoryState();
    this.onError = options.onError;
    this.log = options.log ?? ((line) => console.error(line));
  }

  private async either<T>(shared: () => Promise<T>, local: (fallback: MemoryState) => Promise<T>): Promise<T> {
    try {
      const result = await shared();
      if (this.down) {
        this.down = false;
        this.log("jig gateway: Redis is back; limits and spending are shared again.");
      }
      return result;
    } catch (err) {
      this.onError(err as Error);
      if (!this.down) {
        this.down = true;
        const doing = this.fallback ? "using this replica's own limits and counts until it is back" : "refusing requests (503) until it is back";
        this.log(`jig gateway: Redis can't be reached (${(err as Error).message}); ${doing}.`);
      }
      if (!this.fallback) throw new StateError(`The gateway's shared state can't be reached: ${(err as Error).message}`);
      return local(this.fallback);
    }
  }

  async admit(tenant: string, id: string, limits: { tenant: Limits; global: Limits }): Promise<number> {
    return this.either(
      () => this.redis.admit(tenant, id, limits),
      async (fallback) => {
        const wait = await fallback.admit(tenant, id, limits);
        if (wait === 0) this.local.add(id);
        return wait;
      },
    );
  }

  async release(tenant: string, id: string): Promise<void> {
    if (this.local.delete(id)) return this.fallback!.release(tenant);
    // A slot that can't be given back expires with its lease.
    await this.either(() => this.redis.release(tenant, id), async () => {});
  }

  async renew(tenant: string, id: string): Promise<void> {
    if (!this.local.has(id)) await this.either(() => this.redis.renew(tenant, id), async () => {});
  }

  onRelease(listener: () => void): void {
    this.redis.onRelease(listener);
  }

  async spend(token: TokenPayload, usage: Usage, cost: number | undefined): Promise<void> {
    await this.either(() => this.redis.spend(token, usage, cost), (fallback) => fallback.spend(token, usage, cost));
  }

  async spent(tenant: string, task: string): Promise<Spent | undefined> {
    return this.either(() => this.redis.spent(tenant, task), (fallback) => fallback.spent(tenant, task));
  }

  async spentOn(tenant: string, day: string): Promise<Spent | undefined> {
    return this.either(() => this.redis.spentOn(tenant, day), (fallback) => fallback.spentOn(tenant, day));
  }

  // A key's standing is worth sharing but never worth refusing a request for: without Redis, the gateway
  // goes by what this replica knows.
  async keys(ids: string[]): Promise<KeyState[] | undefined> {
    try {
      return await this.redis.keys(ids);
    } catch (err) {
      this.onError(err as Error);
      return undefined;
    }
  }

  async markKey(id: string, state: "bad" | number): Promise<void> {
    await this.redis.markKey(id, state).catch((err) => this.onError(err));
  }

  close(): void {
    this.redis.close();
    this.fallback?.close();
  }
}
