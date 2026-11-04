// Metrics in Prometheus's text format, for the task service, the gateway and the router to serve at
// GET /metrics: counters, gauges and histograms, each with labels. No client library: the format is a few
// lines of text (https://prometheus.io/docs/instrumenting/exposition_formats/), and what a scrape costs
// is a walk over the series kept here.

import type { ServerResponse } from "node:http";

type Labels = Record<string, string | number>;

/** Seconds, for latencies from a millisecond to ten minutes: model calls, queueing, a task's start. */
export const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600];

/** A label set's key: its pairs in the order the metric names them, so the same labels are one series. */
function keyOf(names: readonly string[], labels: Labels): string {
  return JSON.stringify(names.map((name) => String(labels[name] ?? "")));
}

/** A label's value as the format writes it: backslash, quote and newline escaped. */
function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelText(names: readonly string[], values: string[], extra = ""): string {
  const pairs = names.map((name, i) => `${name}="${escape(values[i]!)}"`);
  if (extra) pairs.push(extra);
  return pairs.length ? `{${pairs.join(",")}}` : "";
}

/** A number as the format writes it. */
function num(value: number): string {
  return Number.isFinite(value) ? String(value) : value > 0 ? "+Inf" : value < 0 ? "-Inf" : "NaN";
}

interface Metric {
  render(): string[];
}

export class Counter implements Metric {
  private readonly series = new Map<string, number>();
  readonly name: string;
  private readonly help: string;
  private readonly labels: readonly string[];
  constructor(name: string, help: string, labels: readonly string[] = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
  }

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0)) throw new Error(`${this.name}: a counter only goes up (by ${by})`);
    const key = keyOf(this.labels, labels);
    this.series.set(key, (this.series.get(key) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.series.get(keyOf(this.labels, labels)) ?? 0;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.series) lines.push(`${this.name}${labelText(this.labels, JSON.parse(key))} ${num(value)}`);
    return lines;
  }
}

export class Gauge implements Metric {
  private readonly series = new Map<string, number>();
  /** Read at each scrape, for what is cheaper to look up than to keep up to date (a queue's length). */
  private collect?: () => Promise<void> | void;
  readonly name: string;
  private readonly help: string;
  private readonly labels: readonly string[];
  constructor(name: string, help: string, labels: readonly string[] = []) {
    this.name = name;
    this.help = help;
    this.labels = labels;
  }

  set(labels: Labels, value: number): void {
    this.series.set(keyOf(this.labels, labels), value);
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = keyOf(this.labels, labels);
    this.series.set(key, (this.series.get(key) ?? 0) + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.inc(labels, -by);
  }

  get(labels: Labels = {}): number {
    return this.series.get(keyOf(this.labels, labels)) ?? 0;
  }

  /** Forgets every series, for a collector that sets them all again. */
  reset(): void {
    this.series.clear();
  }

  onCollect(collect: () => Promise<void> | void): this {
    this.collect = collect;
    return this;
  }

  async refresh(): Promise<void> {
    await this.collect?.();
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.series) lines.push(`${this.name}${labelText(this.labels, JSON.parse(key))} ${num(value)}`);
    return lines;
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly name: string;
  private readonly help: string;
  private readonly labels: readonly string[];
  private readonly buckets: readonly number[];
  constructor(name: string, help: string, labels: readonly string[] = [], buckets: readonly number[] = SECONDS_BUCKETS) {
    this.name = name;
    this.help = help;
    this.labels = labels;
    this.buckets = buckets;
  }

  observe(labels: Labels, value: number): void {
    const key = keyOf(this.labels, labels);
    let series = this.series.get(key);
    if (!series) this.series.set(key, (series = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    this.buckets.forEach((bound, i) => value <= bound && series.counts[i]!++);
    series.sum += value;
    series.count++;
  }

  /** How many were observed, and their sum. */
  get(labels: Labels = {}): { count: number; sum: number } {
    const series = this.series.get(keyOf(this.labels, labels));
    return { count: series?.count ?? 0, sum: series?.sum ?? 0 };
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, { counts, sum, count }] of this.series) {
      const values = JSON.parse(key) as string[];
      this.buckets.forEach((bound, i) => lines.push(`${this.name}_bucket${labelText(this.labels, values, `le="${num(bound)}"`)} ${counts[i]}`));
      lines.push(`${this.name}_bucket${labelText(this.labels, values, 'le="+Inf"')} ${count}`);
      lines.push(`${this.name}_sum${labelText(this.labels, values)} ${num(sum)}`);
      lines.push(`${this.name}_count${labelText(this.labels, values)} ${count}`);
    }
    return lines;
  }
}

/** The metrics one process serves. */
export class Registry {
  private readonly metrics = new Map<string, Metric>();

  private add<M extends Metric & { name: string }>(metric: M): M {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric.name)) throw new Error(`Not a metric name: ${metric.name}`);
    if (this.metrics.has(metric.name)) throw new Error(`A metric named ${metric.name} exists already`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labels: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labels));
  }

  gauge(name: string, help: string, labels: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labels));
  }

  histogram(name: string, help: string, labels: readonly string[] = [], buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, labels, buckets));
  }

  /** Every metric in the text format, the gauges' collectors run first (one that fails leaves its gauge as it was). */
  async render(): Promise<string> {
    for (const metric of this.metrics.values()) if (metric instanceof Gauge) await metric.refresh().catch(() => {});
    return [...this.metrics.values()].flatMap((metric) => metric.render()).join("\n") + "\n";
  }

  /** Answers a GET /metrics. */
  async serve(res: ServerResponse): Promise<void> {
    const body = await this.render();
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(body);
  }
}
