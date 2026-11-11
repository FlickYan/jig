import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { checkConfig, type Config, type Service, startService } from "../server/api.ts";
import { createLog } from "../server/log.ts";
import { checkRouterConfig, type Router, type RouterConfig, startRouter } from "../server/router.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// Several regions: task services that put their region in their tasks' ids, and the router in front of
// them (server/router.ts), which sends each tenant's requests to the region they belong in. The regions are
// real services with the fake jig (fixtures/fake-jig.mjs), or, where only what the router does with an
// answer matters, a few lines of HTTP server. No model is called.

const FAKE_JIG = join(import.meta.dirname, "fixtures", "fake-jig.mjs");
const SECRET = "the gateway's secret";
const KEYS = { acme: "acme-key", globex: "globex-key", initech: "initech-key" };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const services: Service[] = [];
const routers: Router[] = [];
const fakes: Server[] = [];
afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(fakes.splice(0).map((fake) => new Promise((done) => fake.close(done).closeAllConnections())));
  await removeTempDirs();
  await dropPostgresDatabases();
});

/** A region's task service, with the fake jig and the three tenants, its SQLite file and tasks' folders in `base`. */
async function region(name: string | undefined, { base, port = 0, database }: { base?: string; port?: number; database?: string } = {}): Promise<Service & { base: string }> {
  base ??= await tempDir("jig-region-");
  const service = await startService(
    {
      ...(name && { region: name }),
      port,
      internal: { port: 0 },
      database: database ?? join(base, "jig.db"),
      dataDir: join(base, "data"),
      keepTaskDirs: true,
      gatewayBaseUrl: "http://127.0.0.1:9/anthropic",
      jig: [process.execPath, FAKE_JIG],
      graceSeconds: 5,
      tenants: Object.entries(KEYS).map(([id, key]) => ({ id, keys: [sha256(key)] })),
    },
    { secret: SECRET },
  );
  const started = { ...service, base };
  services.push(started);
  return started;
}

/**
 * A router in front of the regions: acme lives in eu and may use us, and fails over to it; globex lives in
 * eu alone; initech in us. Health is asked every 50 ms, and two failures make a region down.
 */
async function router(regions: Record<string, string>, lines: string[] = [], more: Partial<RouterConfig> = {}): Promise<Router> {
  const started = await startRouter(
    {
      ...more,
      listen: { port: 0 },
      metrics: { port: 0 },
      regions: Object.entries(regions).map(([name, url]) => ({ name, url })),
      tenants: [
        { id: "acme", keys: [sha256(KEYS.acme)], home: "eu", allowed: ["eu", "us"], failover: true },
        { id: "globex", keys: [sha256(KEYS.globex)], home: "eu" },
        { id: "initech", keys: [sha256(KEYS.initech)], home: "us", allowed: ["us", "eu"] },
      ],
      health: { intervalMs: 50, failures: 2 },
    },
    { log: createLog("router", { format: "text", level: "debug", write: (line) => lines.push(line) }) },
  );
  routers.push(started);
  return started;
}

interface Answer {
  status: number;
  headers: Headers;
  body: any;
}

async function call(base: string, key: string | undefined, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(key && { authorization: `Bearer ${key}` }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 20))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const statusOf = (base: string, key: string, id: string, status: string) =>
  until(async () => {
    const { body } = await call(base, key, "GET", `/v1/tasks/${id}`);
    return body.status === status && body;
  }, `task ${id} to be ${status}`);

/** A stream's frames as they arrive, each {id?, event?, data}. */
async function* frames(res: Response): AsyncGenerator<{ id?: string; event?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
      const frame: { id?: string; event?: string; data: string } = { data: "" };
      for (const line of buffer.slice(0, end).split("\n")) {
        const [, field, value] = /^([^:]*): ?(.*)$/.exec(line) ?? [];
        if (field === "id" || field === "event" || field === "data") frame[field] = value;
      }
      if (frame.data) yield frame;
    }
  }
}

/** Sends `head` (and `body`) on a socket of its own, as written: a request target fetch() wouldn't send. */
async function raw(base: string, head: string, body = ""): Promise<{ status: number; text: string }> {
  const { hostname, port } = new URL(base);
  const socket = connect(Number(port), hostname);
  // Written, not ended: a client that half-closes its socket has gone away, as far as the router knows.
  socket.write(`${head}\r\nhost: ${hostname}:${port}\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  let text = "";
  for await (const chunk of socket) text += chunk;
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]), text };
}

/**
 * A stand-in for a region's service: its /healthz says it is `name`, its /readyz answers `readyz` (a 503
 * says the database can't be reached; a 404 or 401 is a service from before /readyz) after `readyzMs`, and
 * `serve` answers the rest.
 */
async function fakeRegion(name: string, serve: (req: IncomingMessage, res: ServerResponse) => void, readyz: 200 | 503 | 404 | 401 = 200, readyzMs = 0): Promise<string> {
  const server = createServer((req, res) => {
    const json = (status: number, body: object) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/healthz") return json(200, { ok: true, region: name });
    if (req.url === "/readyz") {
      return void setTimeout(() => {
        if (readyz === 200) return json(200, { ok: true, region: name });
        if (readyz === 503) return json(503, { ok: false, region: name, why: "the database can't be reached" });
        return json(readyz, { error: readyz === 404 ? "Not found" : "A tenant's API key is needed: Authorization: Bearer <key>" });
      }, readyzMs);
    }
    serve(req, res);
  });
  fakes.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const BACKENDS = [
  { name: "SQLite", skip: false },
  { name: "Postgres", skip: NO_POSTGRES },
] as const;

describe("a service in a region", { skip: sandboxProblem() }, () => {
  for (const { name, skip } of BACKENDS) {
    it(`puts its region in its tasks' ids, their view and its /healthz, and takes only its own in a spec, on ${name}`, { skip }, async () => {
      const eu = await region("eu", { database: name === "Postgres" ? await postgresDatabase() : undefined });
      assert.deepEqual((await call(eu.url, undefined, "GET", "/healthz")).body, { ok: true, region: "eu" });
      const created = await call(eu.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
      assert.equal(created.status, 201);
      assert.match(created.body.id, /^task_eu_[0-9a-f]{32}$/);
      assert.equal((await call(eu.url, KEYS.acme, "GET", `/v1/tasks/${created.body.id}`)).body.region, "eu");
      assert.deepEqual((await call(eu.url, KEYS.acme, "GET", "/v1/tasks")).body.tasks.map((task: { region: string }) => task.region), ["eu"]);

      // Its own region is taken, and kept out of the spec; another is refused, and says where to go.
      const named = await call(eu.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: "eu" });
      assert.equal(named.status, 201);
      assert.equal("region" in (await eu.store.task(named.body.id))!.spec, false);
      assert.deepEqual((await call(eu.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: "us" })).body, {
        error: "this is region eu; post to region us's service or through the router",
      });
      assert.deepEqual((await call(eu.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: 5 })).body, { error: "region must be a region's name" });
      // Both end before the service closes, which would otherwise pull their store and folders from under them.
      for (const id of [created.body.id, named.body.id]) await statusOf(eu.url, KEYS.acme, id, "succeeded");
    });
  }

  it("without a region, makes ids as before and refuses a spec that names one", async () => {
    const plain = await region(undefined);
    assert.deepEqual((await call(plain.url, undefined, "GET", "/healthz")).body, { ok: true, region: null });
    const { body } = await call(plain.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.match(body.id, /^task_[0-9a-f]{32}$/);
    assert.equal((await call(plain.url, KEYS.acme, "GET", `/v1/tasks/${body.id}`)).body.region, null);
    const refused = await call(plain.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: "eu" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "this is a service with no region; post to region eu's service or through the router");
    await statusOf(plain.url, KEYS.acme, body.id, "succeeded");
    assert.throws(() => checkConfig({ region: "EU-1" } as unknown as Config), /The config's region must be 1 to 16 lowercase letters and digits, not "EU-1"/);
  });
});

describe("the router", () => {
  it("sends a tenant's new tasks to its home region, or to an allowed one its spec names, with the region and a request id on each answer", { skip: sandboxProblem() }, async () => {
    const eu = await region("eu");
    const us = await region("us");
    const front = await router({ eu: eu.url, us: us.url });

    const home = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" }, { "x-request-id": "req-1.a" });
    assert.equal(home.status, 201);
    assert.match(home.body.id, /^task_eu_/);
    assert.equal(home.headers.get("x-jig-region"), "eu");
    assert.equal(home.headers.get("x-request-id"), "req-1.a");
    assert.ok(await eu.store.task(home.body.id));
    assert.equal(await us.store.task(home.body.id), undefined);
    const initech = (await call(front.url, KEYS.initech, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    assert.match(initech, /^task_us_/);

    const named = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: "us" }, { "x-request-id": "not a valid id!" });
    assert.equal(named.status, 201);
    assert.match(named.body.id, /^task_us_/);
    assert.equal(named.headers.get("x-jig-region"), "us");
    assert.match(named.headers.get("x-request-id")!, /^[\w.-]{1,128}$/);
    assert.notEqual(named.headers.get("x-request-id"), "not a valid id!");

    // A region the tenant may not use is refused before any region sees it.
    const forbidden = await call(front.url, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0", region: "us" });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.region, "us");
    assert.equal(forbidden.headers.get("x-jig-region"), null);
    assert.deepEqual((await call(us.url, KEYS.globex, "GET", "/v1/tasks")).body, { tasks: [] });
    assert.equal((await call(front.url, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0", region: "mars" })).status, 403);
    // A region that is no region's name is the service's 400, before any region sees it.
    for (const named of [null, 5]) {
      const wrong = await call(front.url, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0", region: named });
      assert.equal(wrong.status, 400);
      assert.deepEqual(wrong.body, { error: "region must be a region's name" });
      assert.equal(wrong.headers.get("x-jig-region"), null);
    }
    for (const service of [eu, us]) assert.deepEqual((await call(service.url, KEYS.globex, "GET", "/v1/tasks")).body, { tasks: [] });

    // The same 401 as a service's, for no key and a key no tenant has.
    for (const key of [undefined, "not-a-key"]) {
      const refused = await call(front.url, key, "GET", "/v1/tasks");
      assert.equal(refused.status, 401);
      assert.deepEqual(refused.body, { error: "A tenant's API key is needed: Authorization: Bearer <key>" });
      assert.ok(refused.headers.get("x-request-id"));
    }
    assert.deepEqual((await call(front.url, undefined, "GET", "/healthz")).body, { ok: true, regions: { eu: true, us: true } });
    await statusOf(front.url, KEYS.acme, home.body.id, "succeeded");
    await statusOf(front.url, KEYS.initech, initech, "succeeded");
    await statusOf(front.url, KEYS.acme, named.body.id, "succeeded");
  });

  it("routes a task's view, its live events and its cancel by the region in its id, and lists a region's tasks", { skip: sandboxProblem() }, async () => {
    const eu = await region("eu");
    const us = await region("us");
    const lines: string[] = [];
    const front = await router({ eu: eu.url, us: us.url }, lines);

    // A task in us streams through the router as it runs: the fake jig waits for go before it ends.
    const waiting = (await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "wait", region: "us" })).body.id;
    const view = await call(front.url, KEYS.acme, "GET", `/v1/tasks/${waiting}`);
    assert.equal(view.body.region, "us");
    assert.equal(view.headers.get("x-jig-region"), "us");
    assert.ok(lines.some((line) => new RegExp(`GET /v1/tasks/${waiting} 200 \\(.*tenant=acme task=${waiting} region=us\\)`).test(line)));
    const res = await fetch(`${front.url}/v1/tasks/${waiting}/events`, { headers: { authorization: `Bearer ${KEYS.acme}` } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("x-jig-region"), "us");
    const stream = frames(res);
    const seen: string[] = [];
    while (seen.at(-1) !== "step") seen.push(JSON.parse((await stream.next()).value!.data).type);
    assert.equal((await call(front.url, KEYS.acme, "GET", `/v1/tasks/${waiting}`)).body.status, "running");
    await writeFile(join(us.base, "data", "tasks", waiting, "work", "go"), "");
    for await (const frame of stream) seen.push(frame.event ?? JSON.parse(frame.data).type);
    assert.deepEqual(seen, ["start", "tool_call", "tool_result", "step", "text", "step", "end", "done"]);
    await statusOf(front.url, KEYS.acme, waiting, "succeeded");

    // A cancel goes to the region the task is in.
    const hanging = (await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "hang" })).body.id;
    assert.match(hanging, /^task_eu_/);
    await statusOf(front.url, KEYS.acme, hanging, "running");
    const cancel = await call(front.url, KEYS.acme, "POST", `/v1/tasks/${hanging}/cancel`);
    assert.equal(cancel.status, 202);
    assert.equal(cancel.headers.get("x-jig-region"), "eu");
    await statusOf(front.url, KEYS.acme, hanging, "cancelled");

    // Each region lists its own; ?region= picks one the tenant may use, the home by default.
    const ids = (answer: Answer) => answer.body.tasks.map((task: { id: string }) => task.id);
    assert.deepEqual(ids(await call(front.url, KEYS.acme, "GET", "/v1/tasks")), [hanging]);
    assert.deepEqual(ids(await call(front.url, KEYS.acme, "GET", "/v1/tasks?region=us")), [waiting]);
    assert.equal((await call(front.url, KEYS.globex, "GET", "/v1/tasks?region=us")).status, 403);
    // So with its limits and what it has used of them: each region answers for itself.
    const limits = async (key: string, query = "") => {
      const { status, body } = await call(front.url, key, "GET", `/v1/limits${query}`);
      return [status, body.region, body.used?.tasksToday];
    };
    assert.deepEqual(await limits(KEYS.acme), [200, "eu", 1]);
    assert.deepEqual(await limits(KEYS.acme, "?region=us"), [200, "us", 1]);
    assert.deepEqual(await limits(KEYS.initech, "?region=eu"), [200, "eu", 0]);
    assert.deepEqual(await limits(KEYS.acme, "?region=all"), [400, "all", undefined]);
    assert.deepEqual(await limits(KEYS.globex, "?region=us"), [403, "us", undefined]);
    assert.equal((await call(front.url, KEYS.acme, "GET", "/v1/limits?region=us&region=eu")).status, 400);
    assert.match(await (await fetch(`${front.metricsUrl}/metrics`)).text(), /^jig_router_requests_total\{region="us",route="limits",status="200"\} 1$/m);

    // An id in a region the tenant may not use, or one there isn't, is a task that doesn't exist.
    assert.deepEqual((await call(front.url, KEYS.globex, "GET", `/v1/tasks/${waiting}`)).body, { error: "No such task" });
    assert.equal((await call(front.url, KEYS.acme, "GET", `/v1/tasks/task_mars_${"0".repeat(32)}`)).status, 404);
    // Another tenant's task in a region it may use is the region's to hide.
    assert.equal((await call(front.url, KEYS.initech, "GET", `/v1/tasks/${waiting}`)).status, 404);
  });

  it("sends new tasks to another region while the home is down if the tenant allows it, never a task's reads, and takes the region back once it answers", { skip: sandboxProblem() }, async () => {
    const eu = await region("eu");
    const us = await region("us");
    const lines: string[] = [];
    const front = await router({ eu: eu.url, us: us.url }, lines);
    const done = (await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    await statusOf(front.url, KEYS.acme, done, "succeeded");

    await eu.close();
    services.splice(services.indexOf(eu), 1);
    await until(async () => (await call(front.url, undefined, "GET", "/healthz")).body.regions.eu === false, "eu to be down");
    assert.ok(lines.some((line) => /region eu is down: 2 health checks failed in a row/.test(line)));

    const moved = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(moved.status, 201);
    assert.match(moved.body.id, /^task_us_/);
    assert.equal(moved.headers.get("x-jig-region"), "us");
    await statusOf(front.url, KEYS.acme, moved.body.id, "succeeded");
    // Not for a tenant without failover, nor a task that names the region that is down, nor a task there.
    for (const [key, body] of [[KEYS.globex, { prompt: "exit 0" }], [KEYS.acme, { prompt: "exit 0", region: "eu" }]] as const) {
      const refused = await call(front.url, key, "POST", "/v1/tasks", body);
      assert.equal(refused.status, 503);
      assert.equal(refused.body.region, "eu");
      assert.ok(refused.headers.get("retry-after"));
    }
    const unreadable = await call(front.url, KEYS.acme, "GET", `/v1/tasks/${done}`);
    assert.equal(unreadable.status, 503);
    assert.match(unreadable.body.error, /Region eu is down: its tasks can't be read or changed until it is back/);

    const metrics = await (await fetch(`${front.metricsUrl}/metrics`)).text();
    assert.match(metrics, /^jig_router_failovers_total\{from="eu",to="us"\} 1$/m);
    assert.match(metrics, /^jig_router_region_up\{region="eu"\} 0$/m);
    assert.match(metrics, /^jig_router_requests_total\{region="us",route="create",status="201"\} 1$/m);
    assert.match(metrics, /^jig_router_requests_total\{region="",route="create",status="503"\} 2$/m);

    // The region comes back where it was, with its tasks.
    await region("eu", { base: eu.base, port: Number(new URL(eu.url).port) });
    await until(async () => (await call(front.url, undefined, "GET", "/healthz")).body.regions.eu, "eu to be up again");
    assert.equal((await call(front.url, KEYS.acme, "GET", `/v1/tasks/${done}`)).body.status, "succeeded");
    const back = (await call(front.url, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).body.id;
    assert.match(back, /^task_eu_/);
    assert.ok(lines.includes("jig router: region eu is up again (region=eu)"));
    await statusOf(front.url, KEYS.globex, back, "succeeded");
  });

  it("counts a region that answers as another as down", async () => {
    const lines: string[] = [];
    const eu = await fakeRegion("us", (_req, res) => res.writeHead(500).end());
    const us = await fakeRegion("us", (_req, res) => res.writeHead(500).end());
    const front = await router({ eu, us }, lines);
    await until(() => front.regions().eu === false, "eu to be down");
    assert.equal(front.regions().us, true);
    assert.ok(lines.some((line) => line.includes('its /readyz says it is region \\"us\\"')));
  });

  it("counts a region whose /readyz fails as down, though its /healthz answers, and fails new tasks over from it", async () => {
    const lines: string[] = [];
    const posted: string[] = [];
    const eu = await fakeRegion("eu", (_req, res) => res.writeHead(500).end(), 503);
    const us = await fakeRegion("us", (req, res) => {
      posted.push(`${req.method} ${req.url}`);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: `task_us_${"f".repeat(32)}`, status: "queued" }));
    });
    const front = await router({ eu, us }, lines);
    await until(() => front.regions().eu === false, "eu to be down");
    assert.ok(lines.some((line) => line.includes("region eu is down: 2 health checks failed in a row") && line.includes("its /readyz answered 503: the database can't be reached")), lines.join("\n"));
    const moved = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" });
    assert.equal(moved.status, 201);
    assert.equal(moved.headers.get("x-jig-region"), "us");
    assert.deepEqual(posted, ["POST /v1/tasks"]);
    assert.equal((await call(front.url, KEYS.globex, "POST", "/v1/tasks", { prompt: "exit 0" })).status, 503);
  });

  it("never fails over a new task with an Idempotency-Key, whose key only its home region knows", async () => {
    const posted: string[] = [];
    const serve = (name: string) => (req: IncomingMessage, res: ServerResponse) => {
      posted.push(`${name} ${req.method} ${req.url} ${req.headers["idempotency-key"]}`);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: `task_${name}_${"f".repeat(32)}`, status: "queued" }));
    };
    const eu = await fakeRegion("eu", serve("eu"), 503);
    const us = await fakeRegion("us", serve("us"));
    const front = await router({ eu, us });
    await until(() => front.regions().eu === false, "eu to be down");
    const failovers = async () => /^jig_router_failovers_total\{from="eu",to="us"\} (\d+)$/m.exec(await (await fetch(`${front.metricsUrl}/metrics`)).text())?.[1] ?? "0";

    const held = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" }, { "idempotency-key": "order-1" });
    assert.deepEqual([held.status, held.body.region], [503, "eu"]);
    assert.equal(held.body.error, "Region eu is down: a create with an Idempotency-Key waits for its home region, where its key is known: try again once it is back");
    assert.ok(Number(held.headers.get("retry-after")) >= 1);
    assert.deepEqual(posted, []);
    assert.equal(await failovers(), "0");

    // Without a key the task still goes to the other region; with one and a region it names, to that one.
    assert.equal((await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" })).headers.get("x-jig-region"), "us");
    assert.equal(await failovers(), "1");
    assert.equal((await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0", region: "us" }, { "idempotency-key": "order-2" })).status, 201);
    assert.deepEqual(posted, ["us POST /v1/tasks undefined", "us POST /v1/tasks order-2"]);
    assert.equal(await failovers(), "1");
  });

  it("passes a new task's Idempotency-Key on to its home region as it came", async () => {
    const keys: unknown[] = [];
    const eu = await fakeRegion("eu", (req, res) => {
      keys.push(req.headers["idempotency-key"]);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: `task_eu_${"f".repeat(32)}`, status: "queued" }));
    });
    const us = await fakeRegion("us", (_req, res) => res.writeHead(500).end());
    const front = await router({ eu, us });
    // The router checks nothing of it: the region's service says what is wrong with a key.
    for (const key of ["order-1", "not a key!"]) assert.equal((await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "exit 0" }, { "idempotency-key": key })).status, 201);
    assert.deepEqual(keys, ["order-1", "not a key!"]);
  });

  it("waits for a /readyz as long as a service's waits for its database, so it hears why the region is down", async () => {
    // A service's /readyz answers within the 2 s it gives its database's ping, and a little more.
    const lines: string[] = [];
    const front = await router({ eu: await fakeRegion("eu", () => {}, 503, 2100), us: await fakeRegion("us", () => {}) }, lines);
    await until(() => front.regions().eu === false, "eu to be down");
    assert.ok(lines.some((line) => line.includes("region eu is down") && line.includes("its /readyz answered 503: the database can't be reached")), lines.join("\n"));
  });

  it("asks the /healthz of a region with no /readyz, a service from before it, and says so once", async () => {
    for (const status of [404, 401] as const) {
      const lines: string[] = [];
      const front = await router({ eu: await fakeRegion("eu", () => {}, status), us: await fakeRegion("eu", () => {}, status) }, lines);
      // Several rounds of checks, every 50 ms.
      await new Promise((done) => setTimeout(done, 400));
      assert.deepEqual(front.regions(), { eu: true, us: false });
      const said = lines.filter((line) => line.includes(`region eu has no /readyz (its /readyz answered ${status}): its /healthz is asked instead`));
      assert.equal(said.length, 1, lines.join("\n"));
      // Its /healthz must still name the region.
      assert.ok(lines.some((line) => line.includes('its /healthz says it is region \\"eu\\"')), lines.join("\n"));
      await (routers.splice(routers.indexOf(front), 1), front.close());
    }
  });

  it("adds up the usage of every region the tenant may use for region=all, and passes the rest on as it is", async () => {
    const asked: { region: string; url: string; authorization?: string; request?: string }[] = [];
    const usage = (name: string, rows: object[], total: object, status = { value: 200 }) => (req: IncomingMessage, res: ServerResponse) => {
      asked.push({ region: name, url: req.url!, authorization: req.headers.authorization, request: req.headers["x-request-id"] as string });
      res.writeHead(status.value, { "content-type": "application/json" }).end(JSON.stringify(status.value === 200 ? { from: "2026-11-01", to: "2026-11-03", rows, total } : { error: "broken" }));
    };
    const sums = (tasks: number, costUsd: number) => ({ tasks, input: tasks * 100, output: tasks * 10, cacheRead: 0, cacheWrite: 0, costUsd, seconds: tasks * 30 });
    const row = (day: string, model: string, tasks: number, costUsd: number) => ({ day, model, ...sums(tasks, costUsd) });
    const usStatus = { value: 200 };
    const eu = await fakeRegion("eu", usage("eu", [row("2026-11-01", "claude-haiku-4-5", 2, 0.1), row("2026-11-02", "claude-haiku-4-5", 1, 0.2)], sums(3, 0.3)));
    const us = await fakeRegion("us", usage("us", [row("2026-11-02", "claude-haiku-4-5", 4, 0.1), row("2026-11-02", "deepseek-flash", 1, 0.05)], sums(5, 0.15), usStatus));
    const front = await router({ eu, us });

    const all = await call(front.url, KEYS.acme, "GET", "/v1/usage?region=all&from=2026-11-01&to=2026-11-03&group=day,model", undefined, { "x-request-id": "bill-7" });
    assert.equal(all.status, 200);
    assert.deepEqual(all.body, {
      from: "2026-11-01",
      to: "2026-11-03",
      rows: [row("2026-11-01", "claude-haiku-4-5", 2, 0.1), row("2026-11-02", "claude-haiku-4-5", 5, 0.3), row("2026-11-02", "deepseek-flash", 1, 0.05)],
      total: sums(8, 0.45),
      regions: ["eu", "us"],
    });
    assert.equal(all.headers.get("x-jig-region"), "eu,us");
    assert.match(await (await fetch(`${front.metricsUrl}/metrics`)).text(), /^jig_router_requests_total\{region="all",route="usage",status="200"\} 1$/m);
    // Each region was asked without the router's own parameter, with the tenant's key and the request's id.
    assert.deepEqual(asked.map(({ region, url }) => [region, url]).sort(), [
      ["eu", "/v1/usage?from=2026-11-01&to=2026-11-03&group=day%2Cmodel"],
      ["us", "/v1/usage?from=2026-11-01&to=2026-11-03&group=day%2Cmodel"],
    ]);
    assert.ok(asked.every(({ authorization, request }) => authorization === `Bearer ${KEYS.acme}` && request === "bill-7"));

    // A region that fails is left out, and said to be; none answering is a 502.
    usStatus.value = 500;
    assert.deepEqual((await call(front.url, KEYS.acme, "GET", "/v1/usage?region=all")).body.regions, ["eu"]);
    assert.equal((await call(front.url, KEYS.acme, "GET", "/v1/usage?region=all&format=csv")).status, 400);
    // A tenant of one region gets that region's, and ?region= asks one alone.
    asked.length = 0;
    assert.deepEqual((await call(front.url, KEYS.globex, "GET", "/v1/usage?region=all")).body.regions, ["eu"]);
    assert.equal((await call(front.url, KEYS.initech, "GET", "/v1/usage")).status, 500);
    assert.deepEqual(asked.map(({ region, url }) => [region, url]), [["eu", "/v1/usage"], ["us", "/v1/usage"]]);
    assert.equal((await call(front.url, KEYS.globex, "GET", "/v1/usage?region=us")).status, 403);
  });

  it("answers 502 for region=all when no region answers", async () => {
    const broken = (_req: IncomingMessage, res: ServerResponse) => res.writeHead(500).end();
    const front = await router({ eu: await fakeRegion("eu", broken), us: await fakeRegion("us", broken) });
    const answer = await call(front.url, KEYS.acme, "GET", "/v1/usage?region=all");
    assert.equal(answer.status, 502);
    assert.deepEqual(answer.body, { error: "No region answered", regions: [] });
  });

  it("refuses a region given twice, as the service refuses its own parameters given twice", async () => {
    const asked: string[] = [];
    const answer = (name: string) => (req: IncomingMessage, res: ServerResponse) => (asked.push(name), res.writeHead(200, { "content-type": "application/json" }).end("{}"));
    const front = await router({ eu: await fakeRegion("eu", answer("eu")), us: await fakeRegion("us", answer("us")) });
    for (const path of ["/v1/usage?region=us&region=eu", "/v1/usage?region=all&region=eu", "/v1/tasks?region=eu&region=eu"]) {
      const refused = await call(front.url, KEYS.acme, "GET", path);
      assert.deepEqual([refused.status, refused.body], [400, { error: "region may be given once" }], path);
    }
    assert.deepEqual(asked, []);
    assert.equal((await call(front.url, KEYS.acme, "GET", "/v1/usage?region=us")).status, 200);
    assert.deepEqual(asked, ["us"]);
  });

  it("closes the request to the region when the client leaves a stream", async () => {
    let closed = false;
    const eu = await fakeRegion("eu", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 1\ndata: ${JSON.stringify({ type: "start" })}\n\n`);
      req.socket.once("close", () => (closed = true));
    });
    const front = await router({ eu, us: await fakeRegion("us", () => {}) });
    const client = new AbortController();
    const id = `task_eu_${"a".repeat(32)}`;
    const res = await fetch(`${front.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${KEYS.acme}` }, signal: client.signal });
    const first = await frames(res).next();
    assert.equal(JSON.parse(first.value!.data).type, "start");
    client.abort();
    await until(() => closed, "the region's request to close");
  });

  it("breaks off the client's stream when the region breaks off its own", async () => {
    const eu = await fakeRegion("eu", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: 1\ndata: ${JSON.stringify({ type: "start" })}\n\n`);
      setTimeout(() => res.destroy(), 50);
    });
    const front = await router({ eu, us: await fakeRegion("us", () => {}) });
    const res = await fetch(`${front.url}/v1/tasks/task_eu_${"c".repeat(32)}/events`, { headers: { authorization: `Bearer ${KEYS.acme}` } });
    const stream = frames(res);
    assert.equal(JSON.parse((await stream.next()).value!.data).type, "start");
    // A client left waiting on the rest would hang: it must hear the stream ended short, and soon.
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error("the client's stream was left open")), 5000)));
    await Promise.race([
      assert.rejects(async () => {
        for await (const _ of stream);
      }),
      hung,
    ]).finally(() => clearTimeout(timer));
  });

  it("sends the region the request's id", async () => {
    const seen: (string | undefined)[] = [];
    const eu = await fakeRegion("eu", (req, res) => {
      seen.push(req.headers["x-request-id"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tasks: [] }));
    });
    const front = await router({ eu, us: await fakeRegion("us", () => {}) });
    // A new id where the client sent none, or one that isn't an id; the client's own where it is one.
    for (const headers of [{}, { "x-request-id": "not a valid id!" }] as Record<string, string>[]) {
      const answer = await call(front.url, KEYS.acme, "GET", "/v1/tasks", undefined, headers);
      assert.equal(seen.at(-1), answer.headers.get("x-request-id"));
      assert.notEqual(seen.at(-1), "not a valid id!");
    }
    await call(front.url, KEYS.acme, "GET", "/v1/tasks", undefined, { "x-request-id": "req-9" });
    assert.equal(seen.at(-1), "req-9");
  });

  it("routes ids by the region in them, the regions the tenant may use, and its home", async () => {
    const asked: string[] = [];
    const recording = (name: string) => (req: IncomingMessage, res: ServerResponse) => {
      asked.push(`${name} ${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    };
    // eu comes first in the config: initech's home, us, is not.
    const front = await router({ eu: await fakeRegion("eu", recording("eu")), us: await fakeRegion("us", recording("us")) });
    const regional = `task_us_${"d".repeat(32)}`;
    for (const [method, path] of [["GET", ""], ["GET", "/events"], ["POST", "/cancel"]]) {
      const answer = await call(front.url, KEYS.globex, method, `/v1/tasks/${regional}${path}`);
      assert.equal(answer.status, 404);
      assert.deepEqual(answer.body, { error: "No such task" });
    }
    assert.deepEqual(asked, []);
    const legacy = `task_${"e".repeat(32)}`;
    for (const [key, home] of [[KEYS.initech, "us"], [KEYS.acme, "eu"]]) {
      asked.length = 0;
      assert.equal((await call(front.url, key, "GET", `/v1/tasks/${legacy}`)).headers.get("x-jig-region"), home);
      assert.deepEqual(asked, [`${home} GET /v1/tasks/${legacy}`]);
    }
  });

  it("takes a client that leaves during a new task's body as no fault of its own", async () => {
    const lines: string[] = [];
    const front = await router({ eu: await fakeRegion("eu", () => {}), us: await fakeRegion("us", () => {}) }, lines);
    const { hostname, port } = new URL(front.url);
    const socket = connect(Number(port), hostname);
    // The 100 Continue says the router has the head, and is reading the body when the client goes.
    socket.write(`POST /v1/tasks HTTP/1.1\r\nhost: ${hostname}:${port}\r\nauthorization: Bearer ${KEYS.acme}\r\ncontent-type: application/json\r\ncontent-length: 1000\r\nexpect: 100-continue\r\n\r\n`);
    await new Promise((done) => socket.once("data", done));
    socket.write('{"prompt": "exit 0", ');
    await new Promise((done) => setTimeout(done, 50));
    socket.destroy();
    await until(() => lines.some((line) => /couldn't route a request|the client left before its body was read/.test(line)), "the router to see the client go");
    assert.ok(!lines.some((line) => line.includes("couldn't route a request")), lines.join("\n"));
    assert.doesNotMatch(await (await fetch(`${front.metricsUrl}/metrics`)).text(), /route="create",status="500"/);
  });

  it("caps a new task's body at maxBodyBytes", async () => {
    const asked: number[] = [];
    const eu = await fakeRegion("eu", async (req, res) => {
      let size = 0;
      for await (const chunk of req) size += chunk.length;
      asked.push(size);
      res.writeHead(201, { "content-type": "application/json" }).end("{}");
    });
    const front = await router({ eu, us: await fakeRegion("us", () => {}) }, [], { maxBodyBytes: 64 });
    const over = await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "x".repeat(87) });
    assert.equal(over.status, 413);
    assert.deepEqual(over.body, { error: "The body is over 64 bytes" });
    assert.deepEqual(asked, []);
    assert.equal((await call(front.url, KEYS.acme, "POST", "/v1/tasks", { prompt: "x".repeat(27) })).status, 201);
    assert.deepEqual(asked, [40]);
  });

  it("stops asking the regions for usage once the client has left, or the router closes", async () => {
    for (const end of ["client", "router"] as const) {
      let asked = false;
      let closed = false;
      const never = (req: IncomingMessage) => {
        asked = true;
        req.socket.once("close", () => (closed = true));
      };
      const front = await router({ eu: await fakeRegion("eu", never), us: await fakeRegion("us", never) });
      const client = new AbortController();
      const answer = fetch(`${front.url}/v1/usage?region=all`, { headers: { authorization: `Bearer ${KEYS.acme}` }, signal: client.signal }).catch(() => undefined);
      await until(() => asked, "a region to be asked");
      if (end === "client") client.abort();
      else await (routers.splice(routers.indexOf(front), 1), front.close());
      // Not after the 30 seconds a region has to answer.
      await until(() => closed, `the region's request to close when the ${end} ends`, 3000);
      await answer;
      // A client that left is no 502 of the router's.
      if (end === "client") {
        await new Promise((done) => setTimeout(done, 100));
        assert.doesNotMatch(await (await fetch(`${front.metricsUrl}/metrics`)).text(), /route="usage",status="502"/);
      }
    }
  });

  it("sends a request whose target names another host to the region all the same, with its key", async () => {
    const asked: string[] = [];
    const elsewhere: string[] = [];
    const eu = await fakeRegion("eu", (req, res) => {
      asked.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" }).end(JSON.stringify({ from: "eu" }));
    });
    const evil = await fakeRegion("evil", (req, res) => {
      elsewhere.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ from: "evil" }));
    });
    const front = await router({ eu, us: await fakeRegion("us", () => {}) });
    const host = new URL(evil).host;
    const id = `task_eu_${"b".repeat(32)}`;
    const auth = `authorization: Bearer ${KEYS.globex}`;
    // Scheme-relative targets and absolute-form ones go to the region the path names; a path that
    // parses to //host/... goes to the region's own service, under its own path.
    for (const [target, method, path] of [
      [`///${host}/v1/tasks/${id}?x=1`, "GET", `/v1/tasks/${id}?x=1`],
      [`http://${host}/v1/tasks/${id}`, "GET", `/v1/tasks/${id}`],
      [`http://${host}/v1/tasks`, "POST", "/v1/tasks"],
      [`///${host}/v1/tasks`, "POST", "/v1/tasks"],
      [`/.//${host}/v1/usage`, "GET", `/${host}/v1/usage`],
    ]) {
      asked.length = 0;
      const answer = await raw(front.url, `${method} ${target} HTTP/1.1\r\n${auth}`, method === "POST" ? JSON.stringify({ prompt: "exit 0" }) : "");
      assert.equal(answer.status, method === "POST" ? 201 : 200, target);
      assert.match(answer.text, /x-jig-region: eu/i);
      assert.match(answer.text, /\{"from":"eu"\}/);
      assert.deepEqual(asked, [`${method} ${path} Bearer ${KEYS.globex}`], target);
    }
    assert.deepEqual(elsewhere, []);
  });

  it("serves its metrics and health on a listener of their own", { skip: sandboxProblem() }, async () => {
    const eu = await region("eu");
    const front = await router({ eu: eu.url, us: await fakeRegion("us", () => {}) });
    await call(front.url, KEYS.acme, "GET", "/v1/tasks");
    const metrics = await (await fetch(`${front.metricsUrl}/metrics`)).text();
    assert.match(metrics, /^jig_router_requests_total\{region="eu",route="list",status="200"\} 1$/m);
    assert.match(metrics, /^jig_router_request_seconds_count\{region="eu",route="list"\} 1$/m);
    assert.match(metrics, /^jig_router_region_up\{region="us"\} 1$/m);
    assert.deepEqual(await (await fetch(`${front.metricsUrl}/healthz`)).json(), { ok: true, regions: { eu: true, us: true } });
    assert.equal((await fetch(`${front.metricsUrl}/v1/tasks`)).status, 404);
    // Not on the public port, where it is a path like any other, and needs a key.
    assert.equal((await fetch(`${front.url}/metrics`)).status, 401);
  });

  it("refuses a config it can't route with, saying what is wrong", () => {
    const base: RouterConfig = { regions: [{ name: "eu", url: "http://eu.example.com" }], tenants: [{ id: "acme", keys: [sha256("k")], home: "eu" }] };
    checkRouterConfig(base);
    const cases: [Partial<RouterConfig>, RegExp][] = [
      [{ regions: [] }, /regions must be a list of \{name, url\}, one at least/],
      [{ regions: [{ name: "EU", url: "http://eu" }] }, /regions\[0\]\.name must be 1 to 16 lowercase letters and digits/],
      [{ regions: [{ name: "eu", url: "eu.example.com" }] }, /regions\[0\]\.url must be the region's service's http or https URL/],
      [{ tenants: [{ id: "acme", keys: [sha256("k")], home: "us" }] }, /tenants\[0\]\.home must be one of the regions \(eu\), not "us"/],
      [{ tenants: [{ id: "acme", keys: [sha256("k")], home: "eu", allowed: ["us"] }] }, /tenants\[0\]\.allowed\[0\] must be one of the regions/],
      [{ tenants: [{ id: "acme", keys: ["abc"], home: "eu" }] }, /tenants\[0\]\.keys\[0\] must be a key's SHA-256 hash/],
      [{ health: { failures: 0 } }, /health\.failures must be a whole number from 1 up/],
      [{ maxBodyBytes: 0 }, /maxBodyBytes must be a whole number from 1 up/],
      [{ metrics: {} as { port: number } }, /metrics\.port is missing/],
    ];
    for (const [change, message] of cases) assert.throws(() => checkRouterConfig({ ...base, ...change }), message);
    const twoRegions = { ...base, regions: [...base.regions, { name: "us", url: "https://us.example.com" }] };
    assert.throws(() => checkRouterConfig({ ...twoRegions, tenants: [{ id: "acme", keys: [sha256("k")], home: "eu", allowed: ["us"] }] }), /tenants\[0\]\.allowed must hold its home, eu/);
  });
});
