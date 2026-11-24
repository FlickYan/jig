// The Docker runner on a real Docker, end to end, with a fake model provider in place of a real one, so no
// task reaches a model API or spends anything: the gateway and the task service run in this process, the
// tasks in containers of deploy/Dockerfile.worker's image. What the tests' fake docker can't show is here:
// a container that reaches the gateway with its token, the folder bound at /task, the events read from it,
// a warm worker taking a task, the disk cap stopping a real container, an approval asked from inside one.
// Needs docker. From the repository's root:
//   node deploy/smoke-docker.ts            build the image, make the network, run the checks, clean up
//   BUILD=0 node deploy/smoke-docker.ts    use the image as it is (IMAGE names it, jig-worker:smoke by default)
// It exits 0 only if every check passed. Where a build can't reach npm or apt directly (behind a proxy with a
// CA of its own), tag a node:22-slim that trusts the CA, and build with --network host and the proxy's
// build args; then BUILD=0.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { startService } from "../server/api.ts";
import { startGateway } from "../server/gateway.ts";
import { type Block, messagesReply } from "../test/fake-api.ts";

const IMAGE = process.env.IMAGE ?? "jig-worker:smoke";
const NETWORK = `jig-smoke-${randomBytes(3).toString("hex")}`;
const SECRET = randomBytes(32).toString("hex");
const PROVIDER_KEY = "not-a-key";
const TENANT_KEY = "smoke-key";
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

/**
 * The provider: a bash call with the prompt's text after "run: ", then "done: " and the call's output; a
 * line of text for any other prompt. It counts the requests it took, each with the real key.
 */
function provider(): { server: ReturnType<typeof createServer>; requests: () => number } {
  let requests = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests++;
      assert.equal(req.headers["x-api-key"], PROVIDER_KEY, "the provider is called with the real key, never a task's token");
      const { messages } = JSON.parse(body) as { messages: { role: string; content: string | { type: string; text?: string; content?: unknown }[] }[] };
      const parts = (content: (typeof messages)[number]["content"]) => (typeof content === "string" ? [{ type: "text", text: content }] : content);
      const result = parts(messages.at(-1)!.content).find((part) => part.type === "tool_result");
      const asked = messages.flatMap((message) => (message.role === "user" ? parts(message.content) : [])).map((part) => part.text ?? "").join("\n");
      const command = /run: (.*)/.exec(asked)?.[1];
      const reply: Block[] = result ? [{ text: `done: ${JSON.stringify(result.content).slice(0, 2000)}` }] : command ? [{ tool: "bash", input: { command } }] : [{ text: "nothing to run" }];
      res.writeHead(200, { "content-type": "text/event-stream" }).end(messagesReply(reply));
    });
  });
  return { server, requests: () => requests };
}

async function main(): Promise<void> {
  const cleanup: (() => unknown)[] = [];
  let failed = false;
  try {
    if (process.env.BUILD !== "0") {
      console.log(`building ${IMAGE}`);
      execFileSync("docker", ["build", "-q", "-f", "deploy/Dockerfile.worker", "-t", IMAGE, "."], { stdio: ["ignore", "ignore", "inherit"] });
    }
    // Not --internal: the gateway and the service are this process, on the host, which the containers
    // reach at the network's gateway address. A deployment's network is internal (docs/server.md).
    docker("network", "create", NETWORK);
    cleanup.push(() => docker("network", "rm", NETWORK));
    const host = docker("network", "inspect", NETWORK, "--format", "{{(index .IPAM.Config 0).Gateway}}");

    const upstream = provider();
    await new Promise<void>((done) => upstream.server.listen(0, "127.0.0.1", done));
    cleanup.push(() => new Promise((done) => (upstream.server.closeAllConnections(), upstream.server.close(done))));
    const gateway = await startGateway(
      { listen: { host, port: 0 }, upstream: { baseUrl: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`, keyEnv: ["PROVIDER_KEY"] } },
      { JIG_GATEWAY_SECRET: SECRET, PROVIDER_KEY },
    );
    cleanup.push(() => gateway.close());

    // The daemon binds the task folders by their path here, and the containers' user must reach into them.
    const base = mkdtempSync("/var/tmp/jig-smoke-");
    chmodSync(base, 0o755);
    cleanup.push(() => rmSync(base, { recursive: true, force: true }));
    // What the containers are told to call must be known before the listener is there: a free port, then.
    const internalPort = await new Promise<number>((done) => {
      const probe = createServer().listen(0, host, () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => done(port));
      });
    });
    const service = await startService(
      {
        host: "127.0.0.1",
        port: 0,
        internal: { host, port: internalPort },
        internalBaseUrl: `http://${host}:${internalPort}`,
        database: join(base, "jig.db"),
        dataDir: join(base, "data"),
        model: "claude-opus-5-5",
        gatewayBaseUrl: `http://${host}:${new URL(gateway.url).port}/anthropic`,
        graceSeconds: 5,
        // The repository the clone check makes is a folder here.
        gitProtocols: ["file"],
        runner: "docker",
        docker: { image: IMAGE, network: NETWORK, pool: { size: 1, maxIdleSeconds: 120 } },
        // Small, so a command can pass it in seconds; the image's own files aren't in the task's folder.
        maxTaskDiskBytes: 20 * 1024 * 1024,
        tenants: [{ id: "smoke", keys: [createHash("sha256").update(TENANT_KEY).digest("hex")], budgetUsd: 1, concurrency: 2, approvalTimeout: 60 }],
      },
      { secret: SECRET },
    );
    cleanup.push(() => service.close());

    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(service.url + path, {
        method,
        headers: { authorization: `Bearer ${TENANT_KEY}`, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, headers: res.headers, body: (await res.json()) as any };
    };
    const until = async <T>(check: () => Promise<T | undefined | false>, what: string, ms = 120_000): Promise<T> => {
      for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 200))) {
        const result = await check();
        if (result) return result;
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const ended = (id: string) =>
      until(async () => {
        const { body } = await call("GET", `/v1/tasks/${id}`);
        return !["queued", "running"].includes(body.status) && body;
      }, `task ${id} to end`);
    const events = async (id: string): Promise<any[]> => {
      const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` } });
      return (await res.text()).split("\n\n").filter((frame) => /^data:/m.test(frame) && !/^event:/m.test(frame)).map((frame) => JSON.parse(/^data: ?(.*)$/m.exec(frame)![1]));
    };
    /** Follows a task's stream until an event of the type comes, and leaves it there. */
    const seen = async (id: string, type: string): Promise<void> => {
      const stop = new AbortController();
      const res = await fetch(`${service.url}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${TENANT_KEY}` }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)]) });
      let text = "";
      for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
        text += chunk;
        if (text.includes(`"type":"${type}"`)) return stop.abort();
        if (/^event: done/m.test(text)) throw new Error(`the task ended with no ${type} event: ${text.slice(-600)}`);
      }
    };
    const check = async (name: string, run: () => Promise<void>) => {
      const from = Date.now();
      try {
        await run();
        console.log(`ok    ${name} (${((Date.now() - from) / 1000).toFixed(1)} s)`);
      } catch (err) {
        failed = true;
        console.log(`FAIL  ${name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    };

    let first = "";
    await check("a task runs in a container, its workspace's files there, and hands back a file it made", async () => {
      const posted = await call("POST", "/v1/tasks", {
        prompt: "run: cat note.txt && hostname > host.txt && printf 'made in the container\\n' > dist.txt && printf '\\211PNG\\0' > img.bin && id -u",
        workspace: { files: { "note.txt": "hello from the workspace\n" } },
        outputs: ["dist.txt", "host.txt", "nope.txt", "img.bin"],
        maxSteps: 5,
      });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));
      first = posted.body.id;
      const task = await ended(first);
      assert.deepEqual([task.status, task.stop], ["succeeded", "end_turn"], JSON.stringify(task));
      assert.match(task.result, /hello from the workspace.*10001/s, "the command saw the file and ran as the image's user");
      const [dist, hostname, nope, image] = task.outputs;
      assert.deepEqual(dist, { path: "dist.txt", text: "made in the container\n" });
      assert.match(hostname.text, /^[0-9a-f]{12}\n$/, "a container's hostname, not this machine's");
      assert.deepEqual(nope, { path: "nope.txt", problem: "missing" });
      assert.deepEqual(image, { path: "img.bin", base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString("base64") }, "a file that isn't text comes back as its bytes");
      const all = await events(first);
      const types = all.map((event) => event.type);
      assert.deepEqual(types.filter((type) => type !== "notice"), ["start", "step", "tool_call", "tool_result", "step", "text", "outputs", "end"], JSON.stringify(all.filter((event) => event.type === "notice")));
      assert.ok(task.usage && task.cost !== null, "the gateway's count of what it spent is on the task");
    });

    await check("a workspace cloned from a git repository is in the container, where git reads its history", async () => {
      const repo = join(base, "repo");
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { stdio: "ignore" });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      writeFileSync(join(repo, "readme.txt"), "from the repository\n");
      git("add", ".");
      git("commit", "-q", "-m", "the first commit");
      const { status, body } = await call("POST", "/v1/tasks", { prompt: "run: cat readme.txt && git log --format=%s", workspace: { git: `file://${repo}`, ref: "main" }, maxSteps: 5 });
      assert.equal(status, 201, JSON.stringify(body));
      const task = await ended(body.id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.match(task.result, /from the repository.*the first commit/s, task.result);
    });

    await check("the same Idempotency-Key makes no second task", async () => {
      const body = { prompt: "say hello", maxSteps: 2 };
      const one = await call("POST", "/v1/tasks", body, { "idempotency-key": "smoke-1" });
      const two = await call("POST", "/v1/tasks", body, { "idempotency-key": "smoke-1" });
      assert.deepEqual([one.status, two.status, two.body.id], [201, 200, one.body.id]);
      assert.equal((await ended(one.body.id)).status, "succeeded");
    });

    await check("a warm worker takes a task", async () => {
      await until(async () => /jig-pool_/.test(docker("ps", "--filter", `network=${NETWORK}`, "--format", "{{.Names}}")), "a warm worker to wait", 60_000);
      const from = Date.now();
      const { body } = await call("POST", "/v1/tasks", { prompt: "run: echo warm", maxSteps: 5 });
      const task = await ended(body.id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      const metrics = await service.metrics.registry.render();
      assert.match(metrics, /jig_service_pool_takes_total\{result="hit"\} [1-9]/, "a task was started on a warm worker");
      console.log(`      warm task took ${((Date.now() - from) / 1000).toFixed(1)} s end to end`);
    });

    await check("a container whose folder grows past maxTaskDiskBytes is stopped, as disk_limit", async () => {
      const { body } = await call("POST", "/v1/tasks", { prompt: "run: head -c 60000000 /dev/zero | tr '\\0' x > big.bin; sleep 60", maxSteps: 5 });
      const task = await ended(body.id);
      assert.deepEqual([task.status, task.stop], ["error", "disk_limit"], JSON.stringify(task));
      assert.match(task.error, /maxTaskDiskBytes/);
      await until(async () => !docker("ps", "--format", "{{.Names}}").includes(body.id), "its container to be gone", 30_000);
    });

    await check("a command waits for an approval asked from inside the container, and runs once the API allows it", async () => {
      const { body } = await call("POST", "/v1/tasks", { prompt: "run: echo approved > out.txt && cat out.txt", approvals: true, mode: "ask", maxSteps: 5 });
      assert.ok(body.id, JSON.stringify(body));
      const asked = await until(async () => {
        const { body: list } = await call("GET", `/v1/tasks/${body.id}/approvals`);
        const { body: now } = await call("GET", `/v1/tasks/${body.id}`);
        assert.ok(["queued", "running"].includes(now.status), `the task ended before it asked: ${JSON.stringify(now)}`);
        return list.approvals?.[0];
      }, "the approval to be asked", 60_000);
      const answer = await call("POST", `/v1/tasks/${body.id}/approvals/${asked.id}`, { decision: "allow" });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const task = await ended(body.id);
      assert.equal(task.status, "succeeded", JSON.stringify(task));
      assert.match(task.result, /approved/);
    });

    await check("a running task's container is killed by a cancel", async () => {
      const { body } = await call("POST", "/v1/tasks", { prompt: "run: sleep 300", maxSteps: 5 });
      await seen(body.id, "tool_call");
      assert.equal((await call("POST", `/v1/tasks/${body.id}/cancel`)).status, 202);
      assert.equal((await ended(body.id)).status, "cancelled");
      await until(async () => !docker("ps", "--format", "{{.Names}}").includes(body.id), "its container to be gone", 30_000);
    });

    await check("DELETE removes an ended task's content, and its events answer 410", async () => {
      const deleted = await call("DELETE", `/v1/tasks/${first}`);
      assert.equal(deleted.status, 200);
      assert.deepEqual([deleted.body.prompt, deleted.body.result, deleted.body.outputs, typeof deleted.body.purged], ["", null, null, "string"]);
      assert.equal((await call("GET", `/v1/tasks/${first}/approvals`)).status, 410);
    });

    await check("nothing of the tasks is left: no task's container, and no task's folder", async () => {
      await until(async () => !/jig-task_/.test(docker("ps", "-a", "--filter", `network=${NETWORK}`, "--format", "{{.Names}}")), "the tasks' containers to be gone", 30_000);
      await until(async () => readdirSync(join(base, "data", "tasks")).every((name) => name.startsWith("pool_")), "the tasks' folders to be removed", 30_000);
    });
    console.log(`the provider took ${upstream.requests()} requests`);
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    for (const undo of cleanup.reverse()) {
      try {
        await undo();
      } catch (err) {
        console.error("cleanup:", err instanceof Error ? err.message : err);
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

await main();
