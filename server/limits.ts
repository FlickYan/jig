// Admission for the model gateway: requests a minute (a token bucket) and requests in flight, for each
// tenant and for all of them together. A request over a limit waits in a queue that serves the tenants
// in turn, so one tenant flooding the gateway delays another's request by one slot at most, and after
// the longest wait it is turned away with a time to try again.

export interface Limits {
  /** Requests a minute, refilled continuously. Left out: no limit. */
  requestsPerMinute?: number;
  /** How many requests can go at once after a quiet spell (default: requestsPerMinute). */
  burst?: number;
  /** Requests in flight at once, streaming replies included. Left out: no limit. */
  concurrent?: number;
}

export interface LimiterOptions {
  /** For all tenants together: `concurrent` is the most the gateway sends upstream at once. */
  global: Limits;
  tenants?: Record<string, Limits>;
  /** For a tenant `tenants` doesn't name. */
  tenantDefaults?: Limits;
  /** How long a request may wait for its turn, in milliseconds. */
  maxWaitMs: number;
}

/** A request let through, which must release its slot when its reply is over; or turned away. */
export type Admission = { release(): void } | { retryAfter: number };

class Bucket {
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
}

interface Waiter {
  tenant: string;
  done(admission: Admission): void;
  timer?: NodeJS.Timeout;
}

export class Limiter {
  private readonly options: LimiterOptions;
  private readonly buckets = new Map<string, Bucket | undefined>();
  private readonly globalBucket?: Bucket;
  private readonly flying = new Map<string, number>();
  private total = 0;
  /** Each tenant's waiting requests, first come first. */
  private readonly queues = new Map<string, Waiter[]>();
  /** The tenants in the order they take turns, and whose turn is next. */
  private readonly order: string[] = [];
  private next = 0;
  private refill?: NodeJS.Timeout;

  constructor(options: LimiterOptions) {
    this.options = options;
    const { requestsPerMinute, burst } = options.global;
    if (requestsPerMinute) this.globalBucket = new Bucket(requestsPerMinute, burst, Date.now());
  }

  /** Requests in flight, in all and by tenant. */
  get inFlight(): { total: number; byTenant: Map<string, number> } {
    return { total: this.total, byTenant: this.flying };
  }

  /** Requests waiting for their turn. */
  get queued(): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  }

  /** Waits for `tenant`'s turn, up to the longest wait; a request whose client went away (`signal`) leaves the queue. */
  acquire(tenant: string, signal?: AbortSignal): Promise<Admission> {
    return new Promise((resolve) => {
      const waiter: Waiter = { tenant, done: resolve };
      if (!this.queues.has(tenant)) {
        this.queues.set(tenant, []);
        this.order.push(tenant);
      }
      this.queues.get(tenant)!.push(waiter);
      this.pump();
      if (!this.queues.get(tenant)!.includes(waiter)) return;
      const leave = (retryAfter: number) => {
        this.remove(waiter);
        resolve({ retryAfter });
      };
      waiter.timer = setTimeout(() => {
        const wait = this.wait(tenant, Date.now());
        leave(Math.max(1, Math.ceil((Number.isFinite(wait) ? wait : 1000) / 1000)));
      }, this.options.maxWaitMs);
      signal?.addEventListener("abort", () => leave(1), { once: true });
    });
  }

  /** Turns away everything still waiting, for a gateway that is closing. */
  close(): void {
    clearTimeout(this.refill);
    for (const queue of this.queues.values()) {
      for (const waiter of queue.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.done({ retryAfter: 1 });
      }
    }
  }

  private limits(tenant: string): Limits {
    return this.options.tenants?.[tenant] ?? this.options.tenantDefaults ?? {};
  }

  private bucket(tenant: string): Bucket | undefined {
    if (!this.buckets.has(tenant)) {
      const { requestsPerMinute, burst } = this.limits(tenant);
      this.buckets.set(tenant, requestsPerMinute ? new Bucket(requestsPerMinute, burst, Date.now()) : undefined);
    }
    return this.buckets.get(tenant);
  }

  /** Milliseconds until `tenant` may send its next request: 0 now, Infinity until a request in flight ends. */
  private wait(tenant: string, now: number): number {
    if (this.total >= (this.options.global.concurrent ?? Infinity)) return Infinity;
    if ((this.flying.get(tenant) ?? 0) >= (this.limits(tenant).concurrent ?? Infinity)) return Infinity;
    return Math.max(this.globalBucket?.wait(now) ?? 0, this.bucket(tenant)?.wait(now) ?? 0);
  }

  private remove(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const queue = this.queues.get(waiter.tenant)!;
    if (queue.includes(waiter)) queue.splice(queue.indexOf(waiter), 1);
  }

  /**
   * Lets through whoever can go, a request of each tenant in turn starting after the last one served, and
   * sets a timer for when a bucket next has room. The turn goes by tenant, not by request: a tenant with
   * a thousand requests waiting gets one slot, then the next tenant does.
   */
  private pump(): void {
    clearTimeout(this.refill);
    let soonest = Infinity;
    for (let served = true; served; ) {
      served = false;
      soonest = Infinity;
      for (let i = 0; i < this.order.length; i++) {
        const index = (this.next + i) % this.order.length;
        const tenant = this.order[index];
        const queue = this.queues.get(tenant)!;
        if (!queue.length) continue;
        const now = Date.now();
        const wait = this.wait(tenant, now);
        if (wait > 0) {
          soonest = Math.min(soonest, wait);
          continue;
        }
        this.next = index + 1;
        this.grant(queue[0], now);
        served = true;
        break;
      }
    }
    if (Number.isFinite(soonest)) this.refill = setTimeout(() => this.pump(), Math.ceil(soonest)).unref();
  }

  private grant(waiter: Waiter, now: number): void {
    const { tenant } = waiter;
    this.remove(waiter);
    this.globalBucket?.take(now);
    this.bucket(tenant)?.take(now);
    this.total++;
    this.flying.set(tenant, (this.flying.get(tenant) ?? 0) + 1);
    let released = false;
    waiter.done({
      release: () => {
        if (released) return;
        released = true;
        this.total--;
        this.flying.set(tenant, this.flying.get(tenant)! - 1);
        this.pump();
      },
    });
  }
}
