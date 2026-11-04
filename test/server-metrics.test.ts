import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLog } from "../server/log.ts";
import { Registry } from "../server/metrics.ts";

// The metrics and logs the task service, the gateway and the router share: Prometheus's text format, and
// lines as plain text or JSON.

describe("metrics", () => {
  it("writes counters, gauges and histograms in Prometheus's text format", async () => {
    const registry = new Registry();
    const requests = registry.counter("jig_requests_total", "Requests.", ["tenant", "status"]);
    requests.inc({ tenant: "acme", status: 200 });
    requests.inc({ tenant: "acme", status: 200 }, 2);
    requests.inc({ tenant: 'we"ird\\', status: 429 });
    const queued = registry.gauge("jig_queued", "Queued tasks.", ["tenant"]);
    let calls = 0;
    queued.onCollect(() => {
      calls++;
      queued.reset();
      queued.set({ tenant: "acme" }, 3);
    });
    const latency = registry.histogram("jig_seconds", "Latency.", ["route"], [0.1, 1]);
    latency.observe({ route: "a" }, 0.05);
    latency.observe({ route: "a" }, 0.5);
    latency.observe({ route: "a" }, 5);

    const text = await registry.render();
    assert.equal(calls, 1);
    assert.equal(
      text,
      [
        "# HELP jig_requests_total Requests.",
        "# TYPE jig_requests_total counter",
        'jig_requests_total{tenant="acme",status="200"} 3',
        'jig_requests_total{tenant="we\\"ird\\\\",status="429"} 1',
        "# HELP jig_queued Queued tasks.",
        "# TYPE jig_queued gauge",
        'jig_queued{tenant="acme"} 3',
        "# HELP jig_seconds Latency.",
        "# TYPE jig_seconds histogram",
        'jig_seconds_bucket{route="a",le="0.1"} 1',
        'jig_seconds_bucket{route="a",le="1"} 2',
        'jig_seconds_bucket{route="a",le="+Inf"} 3',
        'jig_seconds_sum{route="a"} 5.55',
        'jig_seconds_count{route="a"} 3',
        "",
      ].join("\n"),
    );
    assert.equal(requests.get({ tenant: "acme", status: 200 }), 3);
    assert.deepEqual(latency.get({ route: "a" }), { count: 3, sum: 5.55 });
  });

  it("refuses a counter going down, a bad name and a name used twice, and survives a failing collector", async () => {
    const registry = new Registry();
    const counter = registry.counter("jig_x_total", "X.");
    assert.throws(() => counter.inc({}, -1), /only goes up/);
    assert.throws(() => registry.gauge("jig-bad", "Bad."), /Not a metric name/);
    assert.throws(() => registry.counter("jig_x_total", "Again."), /exists already/);
    registry.gauge("jig_g", "G.").onCollect(() => {
      throw new Error("the database is away");
    });
    assert.match(await registry.render(), /# TYPE jig_g gauge/);
  });
});

describe("logs", () => {
  const at = () => new Date("2026-11-04T12:00:00.000Z");

  it("writes plain lines as before, with the fields after them", () => {
    const lines: string[] = [];
    const log = createLog("service", { format: "text", write: (line) => lines.push(line), now: at });
    log.info("listening on http://127.0.0.1:8080");
    log.with({ task: "task_1" }).error("couldn't store how it ended", { err: new Error("disk full"), note: "two words" });
    log.debug("dropped below info");
    assert.deepEqual(lines, ["jig service: listening on http://127.0.0.1:8080", 'jig service: couldn\'t store how it ended (task=task_1 err="disk full" note="two words")']);
  });

  it("writes one JSON object a line, its fields its own", () => {
    const lines: string[] = [];
    const log = createLog("gateway", { format: "json", level: "debug", write: (line) => lines.push(line), now: at });
    log.with({ tenant: "acme" }).warn("key rate-limited", { key: "k1", retryMs: 30000 });
    log.debug("detail");
    const first = JSON.parse(lines[0]!);
    assert.deepEqual(first, { ts: "2026-11-04T12:00:00.000Z", level: "warn", component: "gateway", msg: "key rate-limited", tenant: "acme", key: "k1", retryMs: 30000 });
    assert.equal(JSON.parse(lines[1]!).level, "debug");
    log.error("failed", { err: new Error("boom") });
    const error = JSON.parse(lines[2]!);
    assert.equal(error.err.message, "boom");
    assert.match(error.err.stack, /boom/);
  });
});
