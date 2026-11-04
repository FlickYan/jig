import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type FakeApi, fakeMessagesApi, runJig } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// --approve-via: the tool calls jig would ask about at a terminal, asked of a service over HTTP, which a
// person answers through its API while the task waits.

let project: string;
let outside: string;
let file: string;

beforeEach(async () => {
  const base = await tempDir("jig-approvals-");
  project = join(base, "app");
  outside = join(base, "out");
  await mkdir(project);
  await mkdir(outside);
  file = join(outside, "events.jsonl");
});
afterEach(removeTempDirs);

type Event = Record<string, unknown> & { type: string };

const args = ["--no-sandbox", "--model", "claude-opus-5-5"];
const read = async (): Promise<Event[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const ofType = (events: Event[], type: string) => events.filter((event) => event.type === type);
const without = ({ v, seq, ts, ...event }: Event) => event;

/** What a poll gets: a status and maybe a body, the connection dropped, or no answer until jig gives up. */
type Answer = { status: number; body?: object } | "drop" | "hang";

interface Poll {
  url: string;
  authorization?: string;
  at: number;
  /** Whether jig closed the request before it was answered. */
  closed: boolean;
}

/** The service's approvals endpoint, as jig polls it: `answer` says what the nth poll (from 1) of an id gets. */
async function fakeApprovals(answer: (id: string, n: number) => Answer) {
  const polls: Poll[] = [];
  const seen = new Map<string, number>();
  const waiting: ServerResponse[] = [];
  const server = createServer((req, res) => {
    const poll: Poll = { url: req.url ?? "", authorization: req.headers.authorization, at: Date.now(), closed: false };
    polls.push(poll);
    res.on("close", () => (poll.closed = !res.writableEnded));
    const id = poll.url.split("?")[0].split("/").at(-1)!;
    seen.set(id, (seen.get(id) ?? 0) + 1);
    const what = answer(id, seen.get(id)!);
    if (what === "drop") return req.socket.destroy();
    if (what === "hang") return void waiting.push(res);
    res.writeHead(what.status, what.body ? { "content-type": "application/json" } : {});
    res.end(what.body ? JSON.stringify(what.body) : undefined);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/approvals`,
    polls,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A model that runs `commands` in turn, one a step, then says it is done. */
const running = (commands: string[]) =>
  fakeMessagesApi((request) => {
    const calls = (request.messages as unknown[]).length >> 1;
    return calls < commands.length ? [{ tool: "bash", input: { command: commands[calls] } }] : [{ text: "Done." }];
  });

describe("--approve-via", () => {
  it("asks the service where the terminal would ask, polling again after a 204, and answers as yes, always and no do", async () => {
    // Denied, allowed once, allowed always (so the fourth, the same program, isn't asked), then done.
    const commands = ["touch denied", "touch once", "touch always", "touch again"];
    const api = await running(commands);
    const decisions: Record<string, object> = { ap_1: { decision: "deny" }, ap_2: { decision: "allow" }, ap_3: { decision: "allow", always: true } };
    const approvals = await fakeApprovals((id, n) => (n === 1 ? { status: 204 } : { status: 200, body: decisions[id] }));
    try {
      const { code, output } = await runJig([...args, "--approve-via", approvals.url, "--events", file, "Make the files."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.deepEqual(
        ["denied", "once", "always", "again"].map((name) => existsSync(join(project, name))),
        [false, true, true, true],
      );
      const path = new URL(approvals.url).pathname;
      assert.deepEqual(
        approvals.polls.map((poll) => poll.url),
        ["ap_1", "ap_1", "ap_2", "ap_2", "ap_3", "ap_3"].map((id) => `${path}/${id}?wait=25`),
      );
      // The key jig uses for the model: in the service, the task's gateway token.
      assert.ok(approvals.polls.every((poll) => poll.authorization === "Bearer test-key"));
      const events = await read();
      assert.deepEqual(ofType(events, "approval_request").map(without), [
        { type: "approval_request", step: 1, id: "ap_1", tool: "bash", description: "touch denied" },
        { type: "approval_request", step: 2, id: "ap_2", tool: "bash", description: "touch once" },
        { type: "approval_request", step: 3, id: "ap_3", tool: "bash", description: "touch always" },
      ]);
      assert.deepEqual(ofType(events, "approval").map(without), [
        { type: "approval", id: "ap_1", decision: "deny", always: false, by: "api" },
        { type: "approval", id: "ap_2", decision: "allow", always: false, by: "api" },
        { type: "approval", id: "ap_3", decision: "allow", always: true, by: "api" },
      ]);
      // Each after its call and before its result.
      const first = events.map((event) => event.type).slice(0, 7);
      assert.deepEqual(first, ["start", "step", "tool_call", "approval_request", "approval", "tool_result", "step"]);
      assert.match(String(ofType(events, "tool_result")[0].output), /The user declined this tool call/);
    } finally {
      api.close();
      approvals.close();
    }
  });

  it("tries again after an error or a dropped connection, waiting 1 second, then 2", async () => {
    const api = await running(["touch made"]);
    const approvals = await fakeApprovals((_, n) => (n === 1 ? { status: 500 } : n === 2 ? "drop" : { status: 200, body: { decision: "allow" } }));
    try {
      const { code, output } = await runJig([...args, "--approve-via", approvals.url, "--events", file, "Make the file."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.ok(existsSync(join(project, "made")));
      const [a, b, c] = approvals.polls.map((poll) => poll.at);
      assert.equal(approvals.polls.length, 3);
      assert.ok(b - a >= 900 && c - b >= 1900, `${b - a} ms, then ${c - b} ms`);
      assert.deepEqual(ofType(await read(), "approval").map(without), [{ type: "approval", id: "ap_1", decision: "allow", always: false, by: "api" }]);
    } finally {
      api.close();
      approvals.close();
    }
  });

  it("denies a call nobody answered by --approval-timeout, a key the service refuses included", async () => {
    // The service knows only the task's token, so every poll with this key gets a 401, and jig keeps trying.
    const api = await running(["touch made"]);
    const approvals = await fakeApprovals(() => ({ status: 401 }));
    try {
      const { code, output } = await runJig([...args, "--approve-via", approvals.url, "--approval-timeout", "1.5", "--events", file, "Make the file."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.equal(existsSync(join(project, "made")), false);
      assert.ok(approvals.polls.length >= 2, `${approvals.polls.length} polls`);
      assert.ok(approvals.polls.every((poll) => poll.authorization === "Bearer test-key"));
      const events = await read();
      assert.deepEqual(ofType(events, "approval").map(without), [{ type: "approval", id: "ap_1", decision: "deny", always: false, by: "timeout" }]);
      assert.match(String(ofType(events, "tool_result")[0].output), /The user declined this tool call/);
    } finally {
      api.close();
      approvals.close();
    }
  });

  it("stops waiting at --time-limit, and at a SIGTERM, ending as either would", async () => {
    const api = await running(["touch made"]);
    const approvals = await fakeApprovals(() => "hang");
    try {
      const { code, output } = await runJig([...args, "--approve-via", approvals.url, "--time-limit", "1", "--events", file, "Make the file."], { api, cwd: project });
      assert.equal(code, 7, output);
      let events = await read();
      assert.deepEqual([events.at(-1)!.type, events.at(-1)!.stop], ["end", "time_limit"]);
      assert.equal(ofType(events, "approval_request").length, 1);
      assert.equal(ofType(events, "approval").length, 0);
      assert.equal(approvals.polls.length, 1);
      // The poll is given up, not left open.
      await waitFor(() => approvals.polls[0].closed);

      const cli = join(import.meta.dirname, "..", "src", "cli.ts");
      const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1" };
      const child = spawn(process.execPath, [cli, ...args, "--approve-via", approvals.url, "--events", file, "Make the file."], { cwd: project, env });
      child.stdin.end();
      const closed = new Promise((done) => child.on("close", done));
      await waitFor(() => approvals.polls.length === 2);
      child.kill("SIGTERM");
      assert.equal(await closed, 143);
      events = await read();
      assert.deepEqual([events.at(-1)!.type, events.at(-1)!.stop, events.at(-1)!.exitCode], ["end", "interrupted", 143]);
      assert.equal(existsSync(join(project, "made")), false);
    } finally {
      api.close();
      approvals.close();
    }
  });

  it("is refused with --yes or --mode auto, without a task, and with a bad address, timeout or no key", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const url = "http://127.0.0.1:9/internal/approvals";
      const refusals: [string[], RegExp, NodeJS.ProcessEnv?][] = [
        [["--approve-via", url, "--yes", "Do it."], /--approve-via .* --yes/],
        [["--approve-via", url, "--mode", "auto", "Do it."], /--approve-via .* --yes/],
        [["--approve-via", url], /--approve-via is for a task given on the command line/],
        [["--approval-timeout", "60", "Do it."], /--approval-timeout is for --approve-via/],
        [["--approve-via", "ftp://example.com/approvals", "Do it."], /--approve-via must be an http or https address/],
        [["--approve-via", url, "--approval-timeout", "0", "Do it."], /--approval-timeout must be a positive number of seconds/],
        [["--approve-via", url, "Do it."], /--approve-via sends the API key/, { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" }],
      ];
      for (const [given, refusal, env] of refusals) {
        const { code, output } = await runJig([...args, ...given], { api, cwd: project, env });
        assert.equal(code, 1, given.join(" "));
        assert.match(output, refusal);
      }
      assert.equal(api.requests.length, 0);
    } finally {
      api.close();
    }
  });
});

/** Resolves once `done` holds, checking every 20 ms. */
async function waitFor(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((wait) => setTimeout(wait, 20));
}
