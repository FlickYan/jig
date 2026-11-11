import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { type Service, startService } from "../server/api.ts";
import { type Gateway, startGateway } from "../server/gateway.ts";
import { Redis } from "../server/redis.ts";
import { startRouter } from "../server/router.ts";
import { mintToken } from "../server/token.ts";
import { costOf } from "../src/prices.ts";
import { sandboxProblem } from "../src/sandbox.ts";
import { type Block, messagesReply } from "./fake-api.ts";
import { dropPostgresDatabases, NO_POSTGRES, postgresDatabase } from "./postgres.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// The whole of Phase 1 at once, with nothing faked but the provider: a task posted to the task service's API
// is scheduled, run by the local runner as the real jig (src/cli.ts) with --events, whose model calls go
// through the gateway with the task's token, to a stand-in for the Messages API that sees only the real key.
// Then Phase 2's approvals the same way: the real jig's --approve-via, answered through the API, with the
// task service's state in SQLite or Postgres and the gateway's in memory or Redis.

const SECRET = "the secret the service and the gateway share";
const PROVIDER_KEY = "sk-the-provider-key";
const TENANT_KEY = "acme-key";
const MODEL = "claude-opus-5-5";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await removeTempDirs();
  await dropPostgresDatabases();
});

interface Seen {
  headers: IncomingHttpHeaders;
  body: { messages: { role: string; content: unknown }[] };
}

/** The provider: answers the n-th request with the n-th reply (the last one again after them). */
async function provider(replies: Block[][]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(body) });
      if (req.headers["x-api-key"] !== PROVIDER_KEY) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesReply(replies[Math.min(seen.length, replies.length) - 1]!));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const REDIS = process.env.JIG_TEST_REDIS_URL;

/** Where the service and the gateway keep their state: SQLite and memory, or Postgres and Redis. */
interface Backends {
  postgres?: boolean;
  redis?: boolean;
}

/** A Redis prefix of the test's own, its keys deleted after (once the gateway is closed). */
function redisPrefix(): string {
  const prefix = `jig:e2e:${randomUUID()}:`;
  closers.unshift(async () => {
    const redis = new Redis(REDIS!);
    const keys = (await redis.command(["KEYS", `${prefix}*`])) as string[];
    if (keys.length) await redis.command(["DEL", ...keys]);
    redis.close();
  });
  return prefix;
}

async function stack(replies: Block[][], backends: Backends = {}, base?: string): Promise<{ service: Service; gateway: Gateway; seen: Seen[]; dataDir: string }> {
  const upstream = await provider(replies);
  const gateway = await startGateway(
    { listen: { port: 0 }, upstream: { baseUrl: upstream.url, keyEnv: ["PROVIDER_KEY"] }, ...(backends.redis && { state: { redis: REDIS!, prefix: redisPrefix() } }) },
    { JIG_GATEWAY_SECRET: SECRET, PROVIDER_KEY },
  );
  closers.push(() => gateway.close());
  base ??= await tempDir("jig-e2e-");
  const dataDir = join(base, "data");
  const service = await startService(
    {
      port: 0,
      internal: { port: 0 },
      database: backends.postgres ? await postgresDatabase() : join(base, "jig.db"),
      dataDir,
      model: MODEL,
      gatewayBaseUrl: `${gateway.url}/anthropic`,
      graceSeconds: 5,
      // The test reads what jig printed in the task's folder.
      keepTaskDirs: true,
      tenants: [{ id: "acme", keys: [sha256(TENANT_KEY)], budgetUsd: 1 }],
    },
    { secret: SECRET },
  );
  closers.push(() => service.close());
  return { service, gateway, seen: upstream.seen, dataDir };
}

async function call(service: Service, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(service.url + path, {
    method,
    headers: { authorization: `Bearer ${TENANT_KEY}`, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 50))) {
    const result = await check();
    if (result) return result;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const ended = (service: Service, id: string) =>
  until(async () => {
    const { body } = await call(service, "GET", `/v1/tasks/${id}`);
    return !["queued", "running"].includes(body.status) && body;
  }, `task ${id} to end`);

/** The task's events as the API streams them, to the end. */
async function events(service: Service, id: string): Promise<{ id: string; event?: string; data: any }[]> {
  const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` } });
  const frames = (await res.text()).split("\n\n").filter((frame) => /^data:/m.test(frame));
  return frames.map((frame) => {
    const field = (name: string) => new RegExp(`^${name}: ?(.*)$`, "m").exec(frame)?.[1];
    const data = field("data")!;
    return { id: field("id")!, event: field("event"), data: field("event") === "done" ? data : JSON.parse(data) };
  });
}

describe("Phase 1 end to end: API, scheduler, local runner, jig --events, gateway", { skip: sandboxProblem() }, () => {
  it("runs a task with the real jig through the gateway, and its events, usage and cost agree everywhere", async () => {
    const { service, gateway, seen, dataDir } = await stack([[{ tool: "bash", input: { command: "cat note.txt" } }], [{ text: "The note says hello." }]]);
    const posted = await call(service, "POST", "/v1/tasks", { prompt: "what does note.txt say?", workspace: { files: { "note.txt": "hello\n" } }, maxSteps: 5 });
    assert.equal(posted.status, 201);
    const task = await ended(service, posted.body.id);

    assert.equal(task.status, "succeeded", JSON.stringify(task));
    assert.equal(task.stop, "end_turn");
    // The provider saw the real key, never the task's token, and the command's output came back to it.
    assert.equal(seen.length, 2);
    for (const request of seen) {
      assert.equal(request.headers["x-api-key"], PROVIDER_KEY);
      assert.doesNotMatch(JSON.stringify(request.headers), /jgt1\./);
    }
    assert.match(JSON.stringify(seen[1]!.body.messages.at(-1)), /hello/);

    const stream = await events(service, task.id);
    const types = stream.filter((frame) => !frame.event).map((frame) => frame.data.type);
    assert.deepEqual(types, ["start", "step", "tool_call", "tool_result", "step", "text", "end"]);
    assert.deepEqual(stream.map((frame) => Number(frame.id)).filter(Boolean), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(stream.at(-1)!.event, "done");
    const end = stream.find((frame) => frame.data.type === "end")!.data;
    assert.equal(end.exitCode, 0);
    assert.match(stream.find((frame) => frame.data.type === "tool_result")!.data.output, /^hello\n[^]*Exit code: 0/);

    // Two calls of 10 input and 5 output tokens each, priced the same by jig, the service and the gateway.
    const usage = { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 };
    assert.deepEqual(end.usage, usage);
    assert.deepEqual(task.usage, usage);
    const cost = costOf(MODEL, usage)!;
    assert.ok(Math.abs(task.cost - cost) < 1e-9);
    assert.doesNotMatch(await readFile(join(dataDir, "tasks", task.id, "output.log"), "utf8"), /jgt1\./, "jig printed its token");
    const taskToken = mintToken(SECRET, { tenant: "acme", task: task.id, exp: Math.floor(Date.now() / 1000) + 600, budgetUsd: 1 });
    const spent = await fetch(`${gateway.url}/usage/${task.id}`, { headers: { authorization: `Bearer ${taskToken}` } });
    assert.equal(spent.status, 200);
    const gw = await spent.json();
    assert.equal(gw.tenant, "acme");
    assert.equal(gw.requests, 2);
    assert.ok(Math.abs(gw.costUsd - cost) < 1e-9);
    assert.equal(gw.budgetUsd, 1);
  });

  it("cancels a running task: the real jig and its command are stopped, and the task ends cancelled", async () => {
    const { service } = await stack([[{ tool: "bash", input: { command: "sleep 60" } }], [{ text: "done" }]]);
    const { body } = await call(service, "POST", "/v1/tasks", { prompt: "wait a minute", maxSteps: 5 });
    await firstOf(service, body.id, "tool_call");
    const cancelled = await call(service, "POST", `/v1/tasks/${body.id}/cancel`);
    assert.ok([200, 202].includes(cancelled.status));
    const started = Date.now();
    const task = await ended(service, body.id);
    assert.equal(task.status, "cancelled");
    assert.equal(task.stop, "interrupted");
    assert.ok(Date.now() - started < 15_000, "the cancel took too long");
  });

  it("keeps a task's commands out of the database, the other tasks' folders and its own records", { skip: sandboxProblem() }, async () => {
    // A command that tries them all, from its project, dataDir/tasks/<id>/work, then does its own work.
    const tries = [
      "head -c 15 $DB; echo",
      "ls ../..",
      "cat ../../*/work/secret.txt ../../*/events.jsonl",
      "echo forged >> ../events.jsonl",
      "echo mine > out.txt && cat out.txt",
    ];
    const replies: Block[][] = [[{ text: "done" }], [{ tool: "bash", input: { command: tries.join("; ") } }], [{ text: "done" }]];
    const { service, dataDir } = await stack(replies);
    replies[1] = [{ tool: "bash", input: { command: tries.join("; ").replace("$DB", join(dirname(dataDir), "jig.db")) } }];
    const first = await call(service, "POST", "/v1/tasks", { prompt: "keep this", workspace: { files: { "secret.txt": "the first task's secret\n" } }, maxSteps: 5 });
    assert.equal((await ended(service, first.body.id)).status, "succeeded");

    const second = await call(service, "POST", "/v1/tasks", { prompt: "look around", maxSteps: 5 });
    const task = await ended(service, second.body.id);
    assert.equal(task.status, "succeeded", JSON.stringify(task));
    const output = (await events(service, task.id)).find((frame) => frame.data.type === "tool_result")!.data.output;
    assert.doesNotMatch(output, /SQLite format/, "the database");
    assert.doesNotMatch(output, new RegExp(first.body.id), "the other task's folder");
    assert.doesNotMatch(output, /the first task's secret/, "the other task's work");
    assert.doesNotMatch(output, /"seq"/, "the tasks' events");
    assert.match(output, /^mine$/m, "its own work");
    assert.doesNotMatch(await readFile(join(dataDir, "tasks", task.id, "events.jsonl"), "utf8"), /^forged$/m, "its own events");
    assert.equal(await readFile(join(dataDir, "tasks", task.id, "work", "out.txt"), "utf8"), "mine\n");
  });

  it("keeps a task's commands and its git out of a repository that holds dataDir", { skip: sandboxProblem() }, async () => {
    // The service run from a git checkout, dataDir in it. A workspace of files has no repository, so jig and
    // git looked up from work/ and found the service's: the sandbox let commands write it, refs and objects,
    // and a task's git add and commit went into it. Outside the temp directory, which commands can write anyway.
    const base = await mkdtemp(join(homedir(), ".jig-e2e-repo-"));
    closers.push(() => rm(base, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: base, encoding: "utf8" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "the service's own commit");
    const before = git("for-each-ref") + git("rev-parse", "HEAD");
    const index = await readFile(join(base, ".git", "index"));
    const tries = [
      "git log --oneline",
      "git add -A && git -c user.name=t -c user.email=t@t commit -qm task && echo committed",
      `echo planted > ${join(base, ".git", "planted")}`,
      `echo ${"0".repeat(40)} > ${join(base, ".git", "refs", "heads", "evil")}`,
      "echo mine > out.txt && cat out.txt",
    ];
    const { service } = await stack([[{ tool: "bash", input: { command: tries.join("; ") } }], [{ text: "done" }]], {}, base);
    const posted = await call(service, "POST", "/v1/tasks", { prompt: "commit it", workspace: { files: { "a.txt": "a\n" } }, maxSteps: 5 });
    const task = await ended(service, posted.body.id);
    assert.equal(task.status, "succeeded", JSON.stringify(task));
    const output = (await events(service, task.id)).find((frame) => frame.data.type === "tool_result")!.data.output;
    assert.doesNotMatch(output, /the service's own commit/, "read the service's repository");
    assert.doesNotMatch(output, /^committed$/m, "committed into it");
    assert.match(output, /^mine$/m, "its own work");
    for (const path of ["planted", join("refs", "heads", "evil")]) assert.equal(existsSync(join(base, ".git", path)), false, path);
    assert.equal(git("for-each-ref") + git("rev-parse", "HEAD"), before);
    assert.deepEqual(await readFile(join(base, ".git", "index")), index);
  });

  it("gives each task's commands a /tmp of their own, kept between its commands and out of the next task's reach", { skip: sandboxProblem() || (process.platform !== "linux" && "local.isolation is Linux's") }, async () => {
    // dataDir outside /tmp, so a task's /tmp is its TMPDIR (in /tmp it would be empty for each command).
    const base = await mkdtemp(join(homedir(), ".jig-e2e-iso-"));
    closers.push(() => rm(base, { recursive: true, force: true }));
    const file = `/tmp/jig-iso-e2e-${randomUUID()}`;
    const replies: Block[][] = [
      [{ tool: "bash", input: { command: `echo "the first task's" > ${file} && echo written` } }],
      [{ tool: "bash", input: { command: `cat ${file}` } }],
      [{ text: "done" }],
      [{ tool: "bash", input: { command: `cat ${file}; ls /tmp /var/tmp; echo probe-done` } }],
      [{ text: "done" }],
    ];
    const { service, dataDir } = await stack(replies, {}, base);
    const outputs = async (id: string) => (await events(service, id)).filter((frame) => frame.data.type === "tool_result").map((frame) => frame.data.output as string);
    const first = await ended(service, (await call(service, "POST", "/v1/tasks", { prompt: "leave a file", maxSteps: 5 })).body.id);
    assert.equal(first.status, "succeeded", JSON.stringify(first));
    const [wrote, read] = await outputs(first.id);
    assert.match(wrote, /^written/);
    assert.match(read, /^the first task's/, "the task's next command reads it");
    // On the machine it is in the task's own temp folder, not in /tmp.
    assert.equal(existsSync(file), false);
    assert.equal(await readFile(join(dataDir, "tasks", first.id, "home", "tmp", file.slice("/tmp/".length)), "utf8"), "the first task's\n");

    const second = await ended(service, (await call(service, "POST", "/v1/tasks", { prompt: "look around", maxSteps: 5 })).body.id);
    assert.equal(second.status, "succeeded", JSON.stringify(second));
    const [probe] = await outputs(second.id);
    assert.match(probe, /^cat: [^\n]+: No such file or directory\n\/tmp:\n\n\/var\/tmp:\nprobe-done\n/);
  });

  it("keeps a task's long outputs, which jig saves in its TMPDIR, out of the other tasks' reach", { skip: sandboxProblem() }, async () => {
    // The first task prints its secret past what the model sees, so jig keeps the whole output in a file,
    // and waits there; the second looks for it where a shared TMPDIR would have put it, and in the first's.
    const secret = `TENANT-A-SECRET-${randomUUID()}`;
    const prints = 'for i in $(seq 1 3000); do echo "line $i $(cat secret.txt)"; done; sleep 60';
    const replies: Block[][] = [[{ tool: "bash", input: { command: prints } }], [{ text: "done" }], [{ text: "done" }]];
    const { service, dataDir } = await stack(replies);
    const first = (await call(service, "POST", "/v1/tasks", { prompt: "print it", workspace: { files: { "secret.txt": `${secret}\n` } }, maxSteps: 5 })).body.id;
    // jig keeps it in the task's own temp folder, in its home.
    const own = join(dataDir, "tasks", first, "home", "tmp");
    await until(async () => {
      const files = (await readdir(own).catch(() => [])).filter((name) => /^jig-output-\w+\.log$/.test(name));
      for (const name of files) if ((await readFile(join(own, name), "utf8")).includes(secret)) return true;
      return false;
    }, "the first task's output file");

    const where = [`${tmpdir()}/jig-output-*.log`, "/tmp/jig-output-*.log", "/var/tmp/jig-output-*.log", "$TMPDIR/jig-output-*.log", `${own}/jig-output-*.log`];
    replies[1] = [{ tool: "bash", input: { command: `cat ${where.join(" ")} 2>/dev/null | grep -m1 TENANT-A-SECRET; echo probe-done` } }];
    const second = await call(service, "POST", "/v1/tasks", { prompt: "look around", maxSteps: 5 });
    const task = await ended(service, second.body.id);
    assert.equal(task.status, "succeeded", JSON.stringify(task));
    const output = (await events(service, task.id)).find((frame) => frame.data.type === "tool_result")!.data.output;
    assert.match(output, /probe-done/);
    assert.doesNotMatch(output, new RegExp(secret));
    await call(service, "POST", `/v1/tasks/${first}/cancel`);
    assert.equal((await ended(service, first)).status, "cancelled");
  });
});

/** Follows the task's event stream until an event of this type comes, then lets go of it. */
async function firstOf(service: Service, id: string, type: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` }, signal: abort.signal });
    let text = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      text += Buffer.from(chunk).toString("utf8");
      if (text.includes(`"type":"${type}"`)) return;
    }
    throw new Error(`the task ended with no ${type} event`);
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

for (const { name, backends, skip } of [
  { name: "SQLite and memory", backends: {}, skip: false },
  { name: "Postgres and Redis", backends: { postgres: true, redis: true }, skip: NO_POSTGRES || (!REDIS && "JIG_TEST_REDIS_URL isn't set") },
]) {
  describe(`Phase 2 end to end, the state in ${name}: the real jig asks through the API before a command`, { skip: skip || sandboxProblem() }, () => {
    /** Posts a task that asks before its command, and waits until the approval waits for an answer. */
    async function asking(service: Service): Promise<{ id: string; approval: any }> {
      const posted = await call(service, "POST", "/v1/tasks", { prompt: "write the file", approvals: true, mode: "ask", maxSteps: 5 });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      const { id } = posted.body;
      await until(async () => (await call(service, "GET", `/v1/tasks/${id}`)).body.pendingApprovals === 1, "the approval to wait");
      const listed = await call(service, "GET", `/v1/tasks/${id}/approvals`);
      assert.equal(listed.body.approvals.length, 1);
      return { id, approval: listed.body.approvals[0] };
    }

    it("runs the command once the API allows it, and the record says the API answered", async () => {
      const { service, seen } = await stack([[{ tool: "bash", input: { command: "echo allowed > out.txt && cat out.txt" } }], [{ text: "Written." }]], backends);
      const { id, approval } = await asking(service);
      assert.equal(approval.id, "ap_1");
      assert.equal(approval.tool, "bash");
      assert.match(approval.description, /echo allowed/);
      assert.equal(approval.decision, undefined);

      const answered = await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" })).status, 409);
      const task = await ended(service, id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.equal(task.pendingApprovals, 0);

      const stream = await events(service, id);
      const types = stream.filter((frame) => !frame.event).map((frame) => frame.data.type);
      assert.deepEqual(types, ["start", "step", "tool_call", "approval_request", "approval", "tool_result", "step", "text", "end"]);
      const { id: approvalId, decision, by } = stream.find((frame) => frame.data.type === "approval")!.data;
      assert.deepEqual({ approvalId, decision, by }, { approvalId: "ap_1", decision: "allow", by: "api" });
      assert.match(stream.find((frame) => frame.data.type === "tool_result")!.data.output, /^allowed\n/);
      assert.match(JSON.stringify(seen[1]!.body.messages.at(-1)), /allowed/);
      const record = (await call(service, "GET", `/v1/tasks/${id}/approvals`)).body.approvals[0];
      assert.equal(record.decision, "allow");
      assert.equal(record.by, "api");
    });

    it("doesn't run the command the API denies, and the model hears it was denied", async () => {
      const { service, seen } = await stack([[{ tool: "bash", input: { command: "echo nope > out.txt" } }], [{ text: "I won't, then." }]], backends);
      const { id } = await asking(service);
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "deny" })).status, 200);
      const task = await ended(service, id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      const stream = await events(service, id);
      assert.equal(stream.find((frame) => frame.data.type === "approval")!.data.decision, "deny");
      assert.equal(seen.length, 2);
      const told = JSON.stringify(seen[1]!.body.messages.at(-1));
      assert.doesNotMatch(told, /Exit code/);
      assert.match(told, /den|declin|not allowed|refus/i);
    });

    it("cancels a task while its approval waits, and the approval waits no more", async () => {
      const { service } = await stack([[{ tool: "bash", input: { command: "echo never > never.txt" } }], [{ text: "done" }]], backends);
      const { id } = await asking(service);
      const started = Date.now();
      assert.ok([200, 202].includes((await call(service, "POST", `/v1/tasks/${id}/cancel`)).status));
      const task = await ended(service, id);
      assert.equal(task.status, "cancelled");
      assert.equal(task.pendingApprovals, 0);
      assert.ok(Date.now() - started < 15_000, "the cancel took too long");
      assert.equal((await call(service, "POST", `/v1/tasks/${id}/approvals/ap_1`, { decision: "allow" })).status, 409);
    });
  });
}

// Phase 3 at once, with nothing faked but the providers: a router in front of two regions, each a task
// service of its own, whose tasks' model calls go through one gateway that fails over from an overloaded
// provider to a second one; the service's and the gateway's quotas; and what the three say at /metrics.

const PRIMARY_KEY = "sk-the-primary-key";

/** A provider that is overloaded: every call gets 529, as the Messages API says it is. */
async function overloaded(): Promise<{ url: string; calls: () => number }> {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      assert.equal(req.headers["x-api-key"], PRIMARY_KEY);
      res.writeHead(529, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
}

/** A metric's value in a scrape, by its labels (in the order the metric names them). */
function metric(text: string, name: string, labels: Record<string, string> = {}): number {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  const line = text.split("\n").find((line) => line.startsWith(`${name}${pairs.length ? `{${pairs.join(",")}}` : ""} `));
  return line ? Number(line.split(" ").at(-1)) : 0;
}

const scrape = async (url: string) => (await fetch(`${url}/metrics`)).text();

for (const { name, backends, skip } of [
  { name: "SQLite and memory", backends: {} as Backends, skip: false },
  { name: "Postgres and Redis", backends: { postgres: true, redis: true } as Backends, skip: NO_POSTGRES || (!REDIS && "JIG_TEST_REDIS_URL isn't set") },
]) {
  describe(`Phase 3 end to end, the state in ${name}: router, two regions, failover, quotas and metrics`, { skip: skip || sandboxProblem() }, () => {
    it("routes tenants' tasks to their regions and fails over, between providers and between regions, within quotas, and counts it all", async () => {
      // Two model calls a task, each of 10 input and 5 output tokens: the gateway's daily quota lets three tasks through.
      const replies: Block[][] = [[{ tool: "bash", input: { command: "echo hi" } }], [{ text: "Done." }]];
      const perTask = costOf(MODEL, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 })!;
      const primary = await overloaded();
      const backup = await provider([...replies, ...replies, ...replies, ...replies]);
      const gateway = await startGateway(
        {
          listen: { port: 0 },
          metrics: { port: 0 },
          upstreams: [
            { name: "primary", baseUrl: primary.url, keyEnv: ["PRIMARY_KEY"] },
            { name: "backup", baseUrl: backup.url, keyEnv: ["PROVIDER_KEY"] },
          ],
          // Every call tries the primary first: no circuit opens in this test.
          failover: { failures: 1000 },
          limits: { tenantDefaults: { dailyUsd: perTask * 2.9 } },
          ...(backends.redis && { state: { redis: REDIS!, prefix: redisPrefix() } }),
        },
        { JIG_GATEWAY_SECRET: SECRET, PROVIDER_KEY, PRIMARY_KEY },
      );
      closers.push(() => gateway.close());

      const region = async (name: string, quotas?: { tasksPerDay: number }) => {
        const base = await tempDir(`jig-e2e-${name}-`);
        const service = await startService(
          {
            region: name,
            port: 0,
            internal: { port: 0 },
            metrics: { port: 0 },
            database: backends.postgres ? await postgresDatabase() : join(base, "jig.db"),
            dataDir: join(base, "data"),
            model: MODEL,
            gatewayBaseUrl: `${gateway.url}/anthropic`,
            graceSeconds: 5,
            tenants: [{ id: "acme", keys: [sha256(TENANT_KEY)], budgetUsd: 1, ...(quotas && { quotas }) }],
          },
          { secret: SECRET },
        );
        let open = true;
        const close = async () => {
          if (open) await service.close();
          open = false;
        };
        closers.push(close);
        return { service, close };
      };
      const us = await region("us", { tasksPerDay: 1 });
      const eu = await region("eu");
      const router = await startRouter({
        listen: { port: 0 },
        metrics: { port: 0 },
        regions: [
          { name: "us", url: us.service.url },
          { name: "eu", url: eu.service.url },
        ],
        tenants: [{ id: "acme", keys: [sha256(TENANT_KEY)], home: "us", allowed: ["us", "eu"], failover: true }],
        health: { intervalMs: 100, failures: 1 },
      });
      closers.push(() => router.close());

      const send = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(router.url + path, {
          method,
          headers: { authorization: `Bearer ${TENANT_KEY}`, ...(body !== undefined && { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, region: res.headers.get("x-jig-region"), retryAfter: res.headers.get("retry-after"), body: await res.json() };
      };
      const finished = (id: string) =>
        until(async () => {
          const { body } = await send("GET", `/v1/tasks/${id}`);
          return !["queued", "running"].includes(body.status) && body;
        }, `task ${id} to end`);

      // Home: the tenant's task goes to us, its id says so, and it is read back from there.
      const home = await send("POST", "/v1/tasks", { prompt: "say hi", maxSteps: 5 });
      assert.equal(home.status, 201, JSON.stringify(home.body));
      assert.equal(home.region, "us");
      assert.match(home.body.id, /^task_us_[0-9a-f]{32}$/);
      const first = await finished(home.body.id);
      assert.equal(first.status, "succeeded", JSON.stringify(first));
      // The primary was overloaded at both of its calls, and the backup answered them.
      assert.equal(primary.calls(), 2);
      assert.equal(backup.seen.length, 2);
      for (const request of backup.seen) assert.equal(request.headers["x-api-key"], PROVIDER_KEY);
      const token = mintToken(SECRET, { tenant: "acme", task: first.id, exp: Math.floor(Date.now() / 1000) + 600, budgetUsd: 1 });
      const used = await (await fetch(`${gateway.url}/usage/${first.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
      assert.deepEqual(used.upstreams, { backup: 2 });
      assert.ok(Math.abs(used.costUsd - perTask) < 1e-9);

      // A spec that names a region is made there.
      const named = await send("POST", "/v1/tasks", { prompt: "say hi", maxSteps: 5, region: "eu" });
      assert.equal(named.status, 201, JSON.stringify(named.body));
      assert.equal(named.region, "eu");
      assert.match(named.body.id, /^task_eu_/);
      assert.equal((await finished(named.body.id)).status, "succeeded");

      // us lets the tenant create one task a day: the next is refused there, with when it may try again.
      const over = await send("POST", "/v1/tasks", { prompt: "say hi", maxSteps: 5 });
      assert.equal(over.status, 429, JSON.stringify(over.body));
      assert.equal(over.region, "us");
      assert.equal(over.body.quota, "tasksPerDay");
      assert.ok(Number(over.retryAfter) > 0);

      // The usage of both regions as one report.
      const usage = await send("GET", "/v1/usage?region=all");
      assert.equal(usage.status, 200, JSON.stringify(usage.body));
      assert.deepEqual(usage.body.regions.sort(), ["eu", "us"]);
      assert.equal(usage.body.total.tasks, 2);
      assert.ok(Math.abs(usage.body.total.costUsd - 2 * perTask) < 1e-9, JSON.stringify(usage.body));

      // us goes down: its tasks wait for it (their data stays there), and new ones go to eu.
      await us.close();
      await until(async () => router.regions().us === false, "the router to see us down", 10_000);
      assert.equal((await send("GET", `/v1/tasks/${first.id}`)).status, 503);
      const moved = await send("POST", "/v1/tasks", { prompt: "say hi", maxSteps: 5 });
      assert.equal(moved.status, 201, JSON.stringify(moved.body));
      assert.equal(moved.region, "eu");
      assert.match(moved.body.id, /^task_eu_/);
      assert.equal((await finished(moved.body.id)).status, "succeeded");

      // Three tasks spent past the gateway's daily quota: a fourth task's model call is refused.
      const fourth = mintToken(SECRET, { tenant: "acme", task: "task_eu_late", exp: Math.floor(Date.now() / 1000) + 600, budgetUsd: null });
      const refused = await fetch(`${gateway.url}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": fourth, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(refused.status, 402);
      assert.equal(((await refused.json()) as any).error.type, "billing_error");
      assert.ok(Number(refused.headers.get("retry-after")) > 0);
      assert.equal(primary.calls(), 6);
      assert.equal(backup.seen.length, 6);

      // What the gateway, the service in eu and the router say about it all.
      const gw = await scrape(gateway.metricsUrl!);
      assert.equal(metric(gw, "jig_gateway_failovers_total", { from: "primary", to: "backup", reason: "status_529" }), 6);
      assert.equal(metric(gw, "jig_gateway_requests_total", { tenant: "acme", upstream: "backup", status: "200" }), 6);
      assert.equal(metric(gw, "jig_gateway_refused_total", { tenant: "acme", reason: "quota" }), 1);
      assert.ok(Math.abs(metric(gw, "jig_gateway_cost_usd_total", { tenant: "acme" }) - 3 * perTask) < 1e-9);
      const service = await scrape(eu.service.metricsUrl!);
      assert.equal(metric(service, "jig_service_tasks_created_total", { tenant: "acme" }), 2);
      assert.equal(metric(service, "jig_service_tasks_ended_total", { tenant: "acme", status: "succeeded" }), 2);
      assert.ok(Math.abs(metric(service, "jig_service_cost_usd_total", { tenant: "acme" }) - 2 * perTask) < 1e-9);
      const routed = await scrape(router.metricsUrl!);
      assert.equal(metric(routed, "jig_router_requests_total", { region: "us", route: "create", status: "201" }), 1);
      assert.equal(metric(routed, "jig_router_requests_total", { region: "us", route: "create", status: "429" }), 1);
      assert.equal(metric(routed, "jig_router_requests_total", { region: "eu", route: "create", status: "201" }), 2);
      assert.equal(metric(routed, "jig_router_failovers_total", { from: "us", to: "eu" }), 1);
      assert.equal(metric(routed, "jig_router_region_up", { region: "us" }), 0);
    });
  });
}
