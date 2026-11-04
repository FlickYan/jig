// Admission for the model gateway: requests a minute (a token bucket) and requests in flight, for each
// tenant and for all of them together. A request over a limit waits in a queue that serves the tenants
// in turn, so one tenant flooding the gateway delays another's request by one slot at most, and after
// the longest wait it is turned away with a time to try again. The counts are the State's (state.ts), in
// this process or in Redis, shared by several gateways; the queue is each gateway's own.

import { randomUUID } from "node:crypto";
import type { State } from "./state.ts";

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

/**
 * A request let through, which must release its slot when its reply is over; or turned away, with `error`
 * when the state couldn't be reached rather than a limit being reached, and with `limit` when it waited
 * its longest: a rate's bucket had no room, or too many requests were in flight.
 */
export type Admission = { release(): void } | { retryAfter: number; error?: Error; limit?: "rate" | "concurrency" };

/** With shared state, how often the waiting requests try again when no release has been heard of. */
const POLL_MS = 250;

interface Waiter {
  tenant: string;
  id: string;
  done(admission: Admission): void;
  timer?: NodeJS.Timeout;
}

export class Limiter {
  private readonly options: LimiterOptions;
  private readonly state: State;
  /** Requests this gateway let through whose reply is not over, and slots on their way back. */
  private flying = 0;
  private readonly releasing = new Set<Promise<void>>();
  /** Each tenant's waiting requests, first come first. */
  private readonly queues = new Map<string, Waiter[]>();
  /** The tenants in the order they take turns, and whose turn is next. */
  private order: string[] = [];
  private next = 0;
  /** Each waiting tenant's last answer from the state: how long until it may go. */
  private readonly waits = new Map<string, number>();
  private refill?: NodeJS.Timeout;
  private pumping = false;
  private again = false;

  constructor(options: LimiterOptions, state: State) {
    this.options = options;
    this.state = state;
    // Another gateway's request ended: a slot may be free.
    state.onRelease(() => this.queued && void this.pump());
  }

  /** Requests waiting for their turn here. */
  get queued(): number {
    return [...this.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  }

  /** Waits for `tenant`'s turn, up to the longest wait; a request whose client went away (`signal`) leaves the queue. */
  acquire(tenant: string, signal?: AbortSignal): Promise<Admission> {
    return new Promise((resolve) => {
      const waiter: Waiter = { tenant, id: randomUUID(), done: resolve };
      if (!this.queues.has(tenant)) {
        this.queues.set(tenant, []);
        this.order.push(tenant);
      }
      this.queues.get(tenant)!.push(waiter);
      const leave = (retryAfter: number, limit?: "rate" | "concurrency") => {
        if (this.remove(waiter)) resolve({ retryAfter, limit });
      };
      waiter.timer = setTimeout(() => {
        // A bucket says when it has room; a slot comes back whenever a reply ends.
        const wait = this.waits.get(tenant) ?? Infinity;
        leave(Math.max(1, Math.ceil((Number.isFinite(wait) ? wait : 1000) / 1000)), Number.isFinite(wait) ? "rate" : "concurrency");
      }, this.options.maxWaitMs);
      signal?.addEventListener("abort", () => leave(1), { once: true });
      void this.pump();
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

  /** Waits, up to `ms`, for the requests let through to have given their slots back. */
  async settle(ms: number): Promise<void> {
    for (const end = Date.now() + ms; (this.flying || this.releasing.size) && Date.now() < end; ) await new Promise((done) => setTimeout(done, 10));
  }

  private limits(tenant: string): { tenant: Limits; global: Limits } {
    return { tenant: this.options.tenants?.[tenant] ?? this.options.tenantDefaults ?? {}, global: this.options.global };
  }

  /** Takes `waiter` out of its queue; false if it had already left it. */
  private remove(waiter: Waiter): boolean {
    clearTimeout(waiter.timer);
    const queue = this.queues.get(waiter.tenant);
    const index = queue?.indexOf(waiter) ?? -1;
    if (index < 0) return false;
    queue!.splice(index, 1);
    return true;
  }

  /**
   * Lets through whoever can go, then sets a timer for when a bucket next has room (and, with shared
   * state, for a quarter second on: a slot another gateway gave back may have gone unheard). One runs at a
   * time; a call while one runs makes it go round again.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return void (this.again = true);
    this.pumping = true;
    clearTimeout(this.refill);
    let soonest = Infinity;
    try {
      do {
        this.again = false;
        soonest = await this.serve();
      } while (this.again);
    } finally {
      this.pumping = false;
    }
    if (!this.queued) return;
    if (this.state.leaseMs) soonest = Math.min(soonest, POLL_MS);
    if (Number.isFinite(soonest)) this.refill = setTimeout(() => void this.pump(), Math.ceil(soonest)).unref();
  }

  /**
   * A request of each tenant in turn, starting after the last one served, until none can go; answers the
   * milliseconds until one may. The turn goes by tenant, not by request: a tenant with a thousand requests
   * waiting gets one slot, then the next tenant does.
   */
  private async serve(): Promise<number> {
    let soonest = Infinity;
    for (let served = true; served; ) {
      served = false;
      soonest = Infinity;
      for (let i = 0; i < this.order.length; i++) {
        const index = (this.next + i) % this.order.length;
        const tenant = this.order[index];
        const waiter = this.queues.get(tenant)?.[0];
        if (!waiter) continue;
        let wait: number;
        try {
          wait = await this.state.admit(tenant, waiter.id, this.limits(tenant));
        } catch (err) {
          if (this.remove(waiter)) waiter.done({ retryAfter: 1, error: err as Error });
          served = true;
          break;
        }
        if (wait > 0) {
          this.waits.set(tenant, wait);
          soonest = Math.min(soonest, wait);
          continue;
        }
        if (this.remove(waiter)) {
          this.next = index + 1;
          this.grant(waiter);
        } else {
          // It left while the state answered: the slot it was given goes back.
          void this.state.release(tenant, waiter.id).catch(() => {});
        }
        served = true;
        break;
      }
    }
    // Tenants with nothing waiting leave the turns, so they don't pile up; but for the one served last, which
    // marks whose turn is next: a tenant that comes along goes before it has another.
    const last = this.order[this.next - 1];
    const kept = (tenant: string) => tenant === last || Boolean(this.queues.get(tenant)?.length);
    this.next = this.order.slice(0, this.next).filter(kept).length;
    this.order = this.order.filter(kept);
    for (const tenant of this.queues.keys()) {
      if (kept(tenant)) continue;
      this.queues.delete(tenant);
      this.waits.delete(tenant);
    }
    return soonest;
  }

  private grant(waiter: Waiter): void {
    const { tenant, id } = waiter;
    this.flying++;
    // A request that streams for long keeps its slot; one of a gateway that died loses it when its lease ends.
    const { leaseMs } = this.state;
    const renewal = leaseMs ? setInterval(() => void this.state.renew(tenant, id).catch(() => {}), leaseMs / 3).unref() : undefined;
    let released = false;
    waiter.done({
      release: () => {
        if (released) return;
        released = true;
        clearInterval(renewal);
        this.flying--;
        const releasing: Promise<void> = this.state
          .release(tenant, id)
          .catch(() => {})
          .finally(() => {
            this.releasing.delete(releasing);
            void this.pump();
          });
        this.releasing.add(releasing);
      },
    });
  }
}
