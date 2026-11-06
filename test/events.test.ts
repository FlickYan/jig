import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createNetServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentUI } from "../src/agent.ts";
import { withContext } from "../src/context.ts";
import { type Event as Written, Events, FLUSH_SECONDS, type Io, Lines } from "../src/events.ts";
import type { CallModel } from "../src/model.ts";
import { type FakeApi, fakeMessagesApi, messagesReply, runJig, systemText } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// --events: the JSON lines a backend reads to follow a one-shot task, in place of the terminal's output.

let project: string;
let outside: string;
let file: string;

beforeEach(async () => {
  const base = await tempDir("jig-events-");
  project = join(base, "app");
  outside = join(base, "out");
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(project, "parser.py"), "def parse(text):\n    return text\n");
  file = join(outside, "events.jsonl");
});
afterEach(removeTempDirs);

type Event = Record<string, unknown> & { v: number; seq: number; ts: string; type: string };

const args = ["--no-sandbox", "--yes", "--model", "claude-opus-5-5"];
const read = async (path = file): Promise<Event[]> => parse(await readFile(path, "utf8"));
const parse = (text: string): Event[] => text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const types = (events: Event[]) => events.map((event) => event.type);
const ofType = (events: Event[], type: string) => events.filter((event) => event.type === type);

describe("--events", () => {
  it("writes start, each step with its usage, the tool calls and results, the text and the end, in order", async () => {
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 1 ? [{ text: "Let me look." }, { tool: "glob", input: { pattern: "*.py" }, id: "call_glob" }] : [{ text: "Done." }],
    );
    try {
      const { code, output } = await runJig([...args, "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 0, output);
      const events = await read();
      assert.deepEqual(types(events), ["start", "step", "text", "tool_call", "tool_result", "step", "text", "end"]);
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, i) => i + 1),
      );
      for (const event of events) {
        assert.equal(event.v, 1);
        assert.equal(new Date(event.ts).toISOString(), event.ts);
      }
      const [start, step, text, call, result, , answer, end] = events;
      assert.deepEqual(
        { task: start.task, cwd: start.cwd, model: start.model, limits: start.limits },
        { task: "Fix the parser.", cwd: await realpath(project), model: "claude-opus-5-5", limits: { maxSteps: 50, timeLimit: null } },
      );
      assert.match(String(start.version), /^\d+\.\d+\.\d+/);
      // The fake API reports 10 tokens in and 5 out for each reply; claude-opus-5-5 costs $4 and $20 a million.
      assert.deepEqual({ ...step, seq: 0, ts: "" }, { v: 1, seq: 0, ts: "", type: "step", step: 1, usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, cost: 0.00014 });
      assert.deepEqual([text.step, text.text], [1, "Let me look."]);
      assert.deepEqual([call.step, call.id, call.name, call.description], [1, "call_glob", "glob", "*.py"]);
      assert.deepEqual([result.step, result.id, result.isError, result.output, result.truncated], [1, "call_glob", false, "parser.py", undefined]);
      assert.deepEqual([answer.step, answer.text], [2, "Done."]);
      assert.deepEqual(
        { stop: end.stop, exitCode: end.exitCode, steps: end.steps, usage: end.usage },
        { stop: "end_turn", exitCode: 0, steps: 2, usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 } },
      );
      assert.ok(Math.abs((end.cost as number) - 0.00028) < 1e-12, String(end.cost));
      assert.equal(typeof end.seconds, "number");
      // The terminal's output is as it was.
      assert.match(output, /● glob \*\.py\n {2}parser\.py\nDone\.\n2 steps · /);
    } finally {
      api.close();
    }
  });

  it("prices each step as the end: by the model the reply names, so a gateway's alias's steps add up to its end", async () => {
    // claude-fast is an alias jig has no price for; the gateway's replies say claude-opus-5-5 served them.
    const api = await fakeMessagesApi((request) => ({
      blocks: (request.messages as unknown[]).length === 1 ? [{ tool: "glob", input: { pattern: "*.py" } }] : [{ text: "Done." }],
      model: "claude-opus-5-5",
    }));
    try {
      const { code, output } = await runJig(["--no-sandbox", "--yes", "--model", "claude-fast", "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 0, output);
      const events = await read();
      const costs = ofType(events, "step").map((step) => step.cost);
      // 10 tokens in and 5 out at claude-opus-5-5's $4 and $20 a million, each.
      assert.deepEqual(costs, [0.00014, 0.00014]);
      const end = events.at(-1)!;
      assert.ok(Math.abs((end.cost as number) - (costs as number[]).reduce((sum, cost) => sum + cost, 0)) < 1e-12, String(end.cost));
    } finally {
      api.close();
    }
  });

  it("ends with the stop and the exit code of a run stopped by --max-steps or --time-limit, the wrap-up as its text", async () => {
    const api = await fakeMessagesApi((request) => {
      if (request.tool_choice) return [{ text: "Listed the files; the fix is left." }];
      const task = JSON.stringify((request.messages as { content: unknown }[])[0].content);
      return [task.includes("Wait") ? { tool: "bash", input: { command: "sleep 30" } } : { tool: "glob", input: { pattern: "*" } }];
    });
    try {
      const steps = await runJig(["--model", "claude-haiku-4-5", "--no-sandbox", "--yes", "--max-steps", "1", "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(steps.code, 2, steps.output);
      const events = await read();
      assert.deepEqual(types(events), ["start", "step", "tool_call", "tool_result", "notice", "call", "text", "notice", "end"]);
      assert.deepEqual(
        ofType(events, "notice").map((event) => event.text),
        ["Out of steps: asking the model where the work stands.", "Stopped after 1 steps (raise the limit with --max-steps)."],
      );
      assert.deepEqual([events[6].step, events[6].text], [1, "Listed the files; the fix is left."]);
      const end = events.at(-1)!;
      // A model without a price has no cost.
      assert.deepEqual([end.stop, end.exitCode, end.steps, end.cost, (end.usage as { input: number }).input], ["max_steps", 2, 1, null, 20]);

      const time = await runJig([...args, "--time-limit", "1", "--events", file, "Wait for the build."], { api, cwd: project });
      assert.equal(time.code, 7, time.output);
      const timed = await read();
      assert.equal(timed[0].type, "start", "the file is written anew");
      assert.deepEqual((timed[0].limits as object), { maxSteps: 50, timeLimit: 1 });
      assert.deepEqual([timed.at(-1)!.stop, timed.at(-1)!.exitCode, timed.at(-1)!.steps], ["time_limit", 7, 1]);
    } finally {
      api.close();
    }
  });

  it("ends with error when the task fails, and with interrupted when jig is killed in it", async () => {
    // Refused with 401 at first; once `hang` is set, takes the request and never answers, and jig is sent SIGTERM.
    let hang: (() => void) | undefined;
    const server = createServer((req, res) => {
      req.resume();
      if (hang) return hang();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    try {
      const failed = await runJig([...args, "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(failed.code, 1, failed.output);
      const events = await read();
      assert.match(String(ofType(events, "notice").at(-1)!.text), /^Authentication failed/);
      assert.deepEqual([events.at(-1)!.type, events.at(-1)!.stop, events.at(-1)!.exitCode, events.at(-1)!.steps], ["end", "error", 1, 0]);

      const child = spawnJig(api, [...args, "--events", file, "Fix the parser."]);
      hang = () => child.kill("SIGTERM");
      assert.equal(await new Promise((done) => child.on("close", done)), 143);
      const killed = (await read()).at(-1)!;
      assert.deepEqual([killed.type, killed.stop, killed.exitCode], ["end", "interrupted", 143]);
    } finally {
      api.close();
    }
  });

  it("ends with error when the run fails after its start, before the task runs", async () => {
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const { code, output } = await runJig([...args, "--add-dir", join(outside, "missing"), "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 1, output);
      const events = await read();
      assert.deepEqual(types(events), ["start", "notice", "end"]);
      assert.match(String(events[1].text), /--add-dir: .* doesn't exist/);
      assert.deepEqual([events[2].stop, events[2].exitCode, events[2].steps], ["error", 1, 0]);
      assert.equal(api.requests.length, 0);
    } finally {
      api.close();
    }
  });

  it("ends with interrupted when jig is stopped before the task starts, by SIGTERM or Ctrl+C", async () => {
    // An MCP server that never answers keeps jig connecting to it, after the start and before the task.
    await mkdir(join(project, ".jig"));
    await writeFile(join(project, ".jig", "settings.json"), JSON.stringify({ mcpServers: { slow: { command: "sh", args: ["-c", "cat >/dev/null"] } } }));
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
        const child = spawnJig(api, [...args, "--events", file, "Fix the parser."], { JIG_TRUST_PROJECT: "1" });
        const closed = new Promise((done) => child.on("close", (code, killedBy) => done(code ?? killedBy)));
        while (!existsSync(file) || !(await readFile(file, "utf8")).includes('"type":"start"')) await new Promise((done) => setTimeout(done, 20));
        child.kill(signal);
        assert.equal(await closed, exitCode, signal);
        const events = await read();
        assert.deepEqual([events.at(-1)!.type, events.at(-1)!.stop, events.at(-1)!.exitCode], ["end", "interrupted", exitCode], signal);
        await rm(file);
      }
      assert.equal(api.requests.length, 0);
    } finally {
      api.close();
    }
  });

  it("blanks out secrets, and cuts a long output from the middle to 4,000 characters", async () => {
    const key = `sk-${"a1".repeat(15)}`;
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: `echo ${key}; seq 1 3000` } }] : [{ text: `Your key is ${key}.` }],
    );
    try {
      const { code, output } = await runJig([...args, "--events", file, `Check ${key}.`], { api, cwd: project });
      assert.equal(code, 0, output);
      const text = await readFile(file, "utf8");
      assert.ok(!text.includes(key), "the key is in no event");
      const events = parse(text);
      assert.equal(ofType(events, "start")[0].task, "Check [REDACTED].");
      assert.match(String(ofType(events, "tool_call")[0].description), /^echo \[REDACTED\]; seq 1 3000/);
      const [result] = ofType(events, "tool_result");
      const shown = String(result.output);
      assert.ok(shown.length <= 4000, `${shown.length} characters`);
      assert.equal(result.truncated, true);
      assert.match(shown, /^\[REDACTED\]\n1\n2\n/);
      assert.match(shown, /characters truncated/);
      assert.match(shown, /\n3000\n\nExit code: 0$/);
      assert.equal(ofType(events, "text").at(-1)!.text, "Your key is [REDACTED].");
    } finally {
      api.close();
    }
  });

  it("with -, puts only the events on stdout, and the terminal's output on stderr", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "glob", input: { pattern: "*" } }] : [{ text: "Done." }]));
    try {
      const { code, stdout, stderr } = await runSplit(api, [...args, "--events", "-", "Fix the parser."]);
      assert.equal(code, 0, stderr);
      const events = parse(stdout);
      assert.deepEqual(types(events), ["start", "step", "tool_call", "tool_result", "step", "text", "end"]);
      assert.match(stderr, /● glob \*\n {2}parser\.py\nDone\.\n2 steps · /);
      // A refusal of its arguments, before anything runs, goes to stderr too: stdout stays for events.
      const refused = await runSplit(api, [...args, "--events", "-", "--max-steps", "0", "Fix the parser."]);
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      assert.match(refused.stderr, /--max-steps must be a positive integer/);
      // So does one of an option jig doesn't know, which comes before it knows where the events go.
      const unknown = await runSplit(api, [...args, "--events", "-", "--bogus", "Fix the parser."]);
      assert.deepEqual([unknown.code, unknown.stdout], [1, ""]);
      assert.match(unknown.stderr, /Unknown option '--bogus'/);
    } finally {
      api.close();
    }
  });

  it("with -, loses no line to a reader that is behind, the end of a run stopped by SIGTERM included", async () => {
    // A reply's text larger than a pipe holds, and than the reader takes in before it stops reading: Node
    // queued what didn't fit in jig, and lost it at the exit a signal brings, the end with it.
    const long = "All work and no play. ".repeat(20_000);
    let waiting!: () => void;
    const second = new Promise<void>((done) => (waiting = done));
    // The first request gets the text and a tool call; the second is taken and never answered.
    let calls = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (calls++ > 0) return waiting();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesReply([{ text: long }, { tool: "glob", input: { pattern: "*" } }]));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    const child = spawnJig(api, [...args, "--events", "-", "Fix the parser."]);
    // A jig held up for good fails the test rather than hangs it.
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      child.stdout.pause(); // the reader is behind: it reads nothing more until jig is stopped
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const closed = new Promise((done) => child.on("close", (code, signal) => done(code ?? signal)));
      // Stopped once jig waits for its second reply: the first's events are written, or held, by then.
      await Promise.race([second, closed]);
      child.kill("SIGTERM");
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stdout.resume(); // and then reads everything
      assert.equal(await closed, 143, stderr);
      assert.ok(stdout.endsWith("\n"), `the last line is whole: ${stdout.length} characters came`);
      const events = parse(stdout);
      assert.deepEqual(
        events.map((event) => event.seq),
        events.map((_, i) => i + 1),
      );
      assert.deepEqual(types(events).slice(0, 3), ["start", "step", "text"]);
      assert.equal(events[2].text, long);
      const end = events.at(-1)!;
      assert.deepEqual([end.type, end.stop, end.exitCode], ["end", "interrupted", 143]);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      api.close();
    }
  });

  it("with -, writes every line by the normal end of a run whose reader is behind, and goes on without it", async () => {
    const long = "All work and no play. ".repeat(40_000);
    let waiting!: () => void;
    const second = new Promise<void>((done) => (waiting = done));
    const api = await fakeMessagesApi((request) => {
      if ((request.messages as unknown[]).length === 1) return [{ text: long }, { tool: "glob", input: { pattern: "*" } }];
      waiting();
      return [{ text: "Done." }];
    });
    const child = spawnJig(api, [...args, "--events", "-", "Fix the parser."]);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      child.stdout.pause(); // behind until jig has asked its second question
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const closed = new Promise((done) => child.on("close", (code, signal) => done(code ?? signal)));
      await Promise.race([second, closed]);
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stdout.resume();
      assert.equal(await closed, 0, stderr);
      const events = parse(stdout);
      assert.deepEqual(types(events), ["start", "step", "text", "tool_call", "tool_result", "step", "text", "end"]);
      assert.equal(events[2].text, long);
      assert.equal(api.requests.length, 2);
      assert.doesNotMatch(stderr, /--events reader/);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      api.close();
    }
  });

  it("with -, goes on while the reader takes nothing, and on SIGTERM gives up on it within 5 s, saying how many events it held", async () => {
    // The text fills the pipe: a jig that waited for the reader ignored SIGTERM, its handler never run.
    const long = "All work and no play. ".repeat(40_000);
    let waiting!: () => void;
    const second = new Promise<void>((done) => (waiting = done));
    let calls = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (calls++ > 0) return waiting();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(messagesReply([{ text: long }, { tool: "glob", input: { pattern: "*" } }]));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    const child = spawnJig(api, [...args, "--events", "-", "Fix the parser."]);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      // The reader never reads, and keeps the pipe open, until jig has exited (Node resumes it then).
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stdout.pause();
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      // Exited, not closed: its stdout isn't closed while the reader leaves it unread.
      const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
      await Promise.race([second, exited]);
      assert.equal(calls, 2, `jig went on to its second request without the reader: ${stderr}`);
      const killed = Date.now();
      child.kill("SIGTERM");
      assert.equal(await exited, 143, stderr);
      const took = Date.now() - killed;
      assert.ok(took >= 4_500 && took < 10_000, `exited ${took} ms after SIGTERM`);
      const [, held] = stderr.match(/The --events reader took nothing for 5 s: (\d+) events? (weren't|wasn't) written\./) ?? [];
      assert.ok(held, stderr);
      // What did arrive: the first lines whole and in order, then perhaps part of the next.
      const closed = new Promise((done) => child.on("close", done));
      child.stdout.resume();
      await closed;
      const events = parse(stdout.slice(0, stdout.lastIndexOf("\n") + 1));
      assert.deepEqual(types(events), ["start", "step", "text", "tool_call", "tool_result"].slice(0, events.length));
      assert.ok(events.length >= 2, `${events.length} whole lines came`);
      // Those and the ones it held are all of them: the five, and the end.
      assert.equal(events.length + Number(held), 6, stderr);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      api.close();
    }
  });

  it("with -, on SIGTERM kills its commands before it waits for a reader that is slow but reads, and waits 20 s at most", async () => {
    // A reader that takes 4 KiB every half second never leaves jig 5 s without progress: jig waited for it to
    // take everything, its command still running, until an orchestrator's SIGKILL.
    const long = "All work and no play. ".repeat(80_000);
    // The command connects here and runs on: its connection closes when it is killed.
    let connected!: () => void;
    const started = new Promise<void>((done) => (connected = done));
    let killed = 0;
    const sockets: Socket[] = [];
    const server = createNetServer((socket) => {
      sockets.push(socket);
      connected();
      socket.on("error", () => {}).on("close", () => (killed = Date.now()));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const command = `'${process.execPath}' -e 'require("node:net").connect(${(server.address() as AddressInfo).port}, "127.0.0.1")'`;
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ text: long }, { tool: "bash", input: { command } }] : [{ text: "Done." }]));
    const reader = spawn(process.execPath, ["-e", SLOW_READER], { stdio: ["pipe", "ignore", "ignore"] });
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1" };
    const child = spawn(process.execPath, [cli, ...args, "--events", "-", "Fix the parser."], { cwd: project, env, stdio: ["ignore", reader.stdin, "pipe"] });
    reader.stdin.destroy(); // jig holds the pipe's end now
    const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
    try {
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
      await Promise.race([started, exited]);
      const sent = Date.now();
      child.kill("SIGTERM");
      assert.equal(await exited, 143, stderr);
      const took = Date.now() - sent;
      assert.ok(killed && killed - sent < 2_000, `the command was killed ${killed ? `${killed - sent} ms` : "never"} after SIGTERM, jig exiting ${took} ms after it`);
      assert.ok(took >= 19_500 && took < 26_000, `exited ${took} ms after SIGTERM`);
      assert.match(stderr, /The --events reader didn't take them all in the 20 s jig gives it after a signal: \d+ events? (weren't|wasn't) written\./);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      reader.kill("SIGKILL");
      for (const socket of sockets) socket.destroy(); // and the command, if jig didn't kill it, ends
      server.close();
      api.close();
    }
  });

  for (const again of ["SIGINT", "SIGTERM"] as const) {
    it(`with -, a ${again === "SIGINT" ? "second Ctrl+C" : "SIGTERM after a Ctrl+C"} while it waits for the reader at the end doesn't kill it: it exits with 130, the end's code, saying so`, async () => {
      // Once the task is over its Ctrl+C handler is gone, so a second Ctrl+C killed jig by the signal's default
      // action as it waited for the reader: no word on stderr, and the end lost.
      const long = "All work and no play. ".repeat(40_000);
      let waiting!: () => void;
      const second = new Promise<void>((done) => (waiting = done));
      let calls = 0;
      const server = createServer((req, res) => {
        req.resume();
        if (calls++ > 0) return waiting();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(messagesReply([{ text: long }, { tool: "glob", input: { pattern: "*" } }]));
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
      const child = spawnJig(api, [...args, "--events", "-", "Fix the parser."]);
      const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
      try {
        child.stdout.pause(); // the reader takes nothing
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
        const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
        await Promise.race([second, exited]);
        const sent = Date.now();
        child.kill("SIGINT");
        await new Promise((done) => setTimeout(done, 200));
        // A SIGTERM once the end is written exited with 143, where the end said 130.
        child.kill(again);
        assert.equal(await exited, 130, stderr);
        const took = Date.now() - sent;
        assert.ok(took >= 4_500, `exited ${took} ms after the first Ctrl+C`);
        assert.match(stderr, /The --events reader took nothing for 5 s: \d+ events? (weren't|wasn't) written\./);
      } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        child.stdout.destroy();
        api.close();
      }
    });
  }

  it("with -, a Ctrl+C while it waits for a slow reader at a normal end still stops it at once", async () => {
    // The signals are ignored only in the wait after a signal, which is bounded in all: at a normal end a
    // reader that keeps reading kept jig going, Ctrl+C ignored, as long as it took 4 KiB every half second.
    const long = "All work and no play. ".repeat(80_000);
    let waiting!: () => void;
    const second = new Promise<void>((done) => (waiting = done));
    const api = await fakeMessagesApi((request) => {
      if ((request.messages as unknown[]).length === 1) return [{ text: long }, { tool: "glob", input: { pattern: "*" } }];
      waiting();
      return [{ text: "Done." }];
    });
    const reader = spawn(process.execPath, ["-e", SLOW_READER], { stdio: ["pipe", "ignore", "ignore"] });
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1" };
    const child = spawn(process.execPath, [cli, ...args, "--events", "-", "Fix the parser."], { cwd: project, env, stdio: ["ignore", reader.stdin, "pipe"] });
    reader.stdin.destroy(); // jig holds the pipe's end now
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
      // A moment after the last reply the task is over, and jig waits for the reader with what it holds.
      await Promise.race([second, exited]);
      await new Promise((done) => setTimeout(done, 1_500));
      const sent = Date.now();
      child.kill("SIGINT");
      assert.equal(await exited, "SIGINT", stderr.slice(-1_000));
      const took = Date.now() - sent;
      assert.ok(took < 2_000, `exited ${took} ms after Ctrl+C`);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      reader.kill("SIGKILL");
      api.close();
    }
  });

  it("with -, on SIGTERM while it waits for a slow reader at a normal end, exits with the end's code within 60 s", async () => {
    // A reader that takes 4 KiB every half second never leaves jig 5 s without progress: at a normal end jig
    // waited for it to take everything, minutes here, and the SIGTERM's handler ran only after that.
    const long = "All work and no play. ".repeat(80_000);
    let waiting!: () => void;
    const second = new Promise<void>((done) => (waiting = done));
    const api = await fakeMessagesApi((request) => {
      if ((request.messages as unknown[]).length === 1) return [{ text: long }, { tool: "glob", input: { pattern: "*" } }];
      waiting();
      return [{ text: "Done." }];
    });
    const reader = spawn(process.execPath, ["-e", SLOW_READER], { stdio: ["pipe", "ignore", "ignore"] });
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1" };
    const child = spawn(process.execPath, [cli, ...args, "--events", "-", "Fix the parser."], { cwd: project, env, stdio: ["ignore", reader.stdin, "pipe"] });
    reader.stdin.destroy(); // jig holds the pipe's end now
    const deadline = setTimeout(() => child.kill("SIGKILL"), 80_000);
    try {
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const exited = new Promise((done) => child.on("exit", (code, signal) => done(code ?? signal)));
      await Promise.race([second, exited]);
      const asked = Date.now();
      await new Promise((done) => setTimeout(done, 1_500));
      child.kill("SIGTERM");
      assert.equal(await exited, 0, stderr.slice(-1_000));
      const took = Date.now() - asked;
      assert.ok(took >= 59_000 && took < 66_000, `exited ${took} ms after the last request`);
      // What it said last may still be on its way when it has exited.
      if (child.stderr.readable) await new Promise((done) => child.stderr.on("close", done));
      assert.match(stderr.slice(-1_000), /The --events reader didn't take them all in the 60 s jig gives it at a normal end: \d+ events? (weren't|wasn't) written\./);
    } finally {
      clearTimeout(deadline);
      child.kill("SIGKILL");
      reader.kill("SIGKILL");
      api.close();
    }
  });

  it("writes each model call that isn't a step's as a call, so the steps' and the calls' costs and tokens add up to the end's", async () => {
    // The end counted the wrap-up, subagents, compaction and the reviewer, the steps only the loop's own calls.
    const sumsUp = (events: Event[]) => {
      const parts = events.filter((event) => event.type === "step" || event.type === "call");
      const end = events.at(-1)!;
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      for (const part of parts) for (const key of Object.keys(usage) as (keyof typeof usage)[]) usage[key] += (part.usage as typeof usage)[key];
      assert.deepEqual(usage, end.usage);
      const cost = parts.reduce((sum, part) => sum + (part.cost as number), 0);
      assert.ok(Math.abs((end.cost as number) - cost) < 1e-12, `${end.cost} against ${cost}`);
    };
    const first = (request: Record<string, unknown>) => JSON.stringify((request.messages as { content: unknown }[])[0].content);
    const last = (request: Record<string, unknown>) => (request.messages as { content: unknown }[]).at(-1)!.content;
    const api = await fakeMessagesApi((request) => {
      if (first(request).includes("Another agent was given the task")) return [{ text: "APPROVED" }];
      if (systemText(request as { system?: string }).includes("You are a subagent")) return [{ text: "parse is in parser.py." }];
      if (String(last(request)).startsWith("You have run out of steps")) return [{ text: "Found the parser; the fix is left." }];
      if (String(last(request)).startsWith("The conversation so far is about to be replaced")) return [{ text: "Listed the files." }];
      if (first(request).includes("was compacted")) return [{ text: "Done." }];
      if (first(request).includes("Find the parser")) return [{ tool: "subagent", input: { description: "find it", prompt: "Where is parse?" } }];
      return [{ tool: "glob", input: { pattern: "*" } }];
    });
    try {
      // Out of steps after a subagent's research: the subagent's call, then the wrap-up.
      const wrapped = await runJig([...args, "--max-steps", "1", "--events", file, "Find the parser."], { api, cwd: project });
      assert.equal(wrapped.code, 2, wrapped.output);
      const events = await read();
      assert.deepEqual(types(events), ["start", "step", "tool_call", "call", "tool_result", "notice", "call", "text", "notice", "end"]);
      assert.deepEqual(
        ofType(events, "call").map((call) => ({ ...call, seq: 0, ts: "" })),
        ["subagent", "wrap-up"].map((what) => ({ v: 1, seq: 0, ts: "", type: "call", for: what, step: 1, usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }, cost: 0.00014 })),
      );
      sumsUp(events);

      // A compaction before the second step, then a reviewer on a model of its own price when the model stops.
      const reviewed = await runJig([...args, "--compact-at", "1", "--reviewer", "claude-sonnet-5-5", "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(reviewed.code, 0, reviewed.output);
      const again = await read();
      assert.deepEqual(
        ofType(again, "call").map((call) => [call.for, call.step]),
        [["compaction", 1], ["review", 2]],
      );
      assert.notEqual(ofType(again, "call")[1].cost, 0.00014, "the reviewer's call is priced by its model");
      sumsUp(again);
    } finally {
      api.close();
    }
  });

  it("with -, goes on with the task when the events' reader is gone, and says so once", async () => {
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "glob", input: { pattern: "*" } }] : [{ text: "Done." }]));
    try {
      const child = spawnJig(api, [...args, "--events", "-", "Fix the parser."]);
      child.stdout.destroy(); // gone before jig writes its first event: each write to the pipe fails with EPIPE
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((done) => child.on("close", done));
      assert.equal(code, 0, stderr);
      assert.equal(api.requests.length, 2);
      assert.equal(stderr.match(/no more events/g)?.length, 1, stderr);
      assert.match(stderr, /Done\.\n2 steps · /);
    } finally {
      api.close();
    }
  });

  it("replaces a link in its place rather than writing through it, and is refused without a task", async () => {
    // A job a command of an earlier run left in the background can plant a link where the next run's file goes.
    const victim = join(outside, "bashrc");
    await writeFile(victim, "the user's own\n");
    await symlink(victim, file);
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const { code, output } = await runJig([...args, "--events", file, "Fix the parser."], { api, cwd: project });
      assert.equal(code, 0, output);
      assert.ok((await lstat(file)).isFile());
      assert.equal(types(await read()).at(-1), "end");
      assert.equal(await readFile(victim, "utf8"), "the user's own\n");

      const other = join(outside, "session.jsonl");
      const session = await runJig([...args, "--events", other], { api, cwd: project });
      assert.equal(session.code, 1, session.output);
      assert.match(session.output, /--events is for a task given on the command line or stdin/);
      assert.equal(existsSync(other), false);
      assert.equal(api.requests.length, 1);
    } finally {
      api.close();
    }
  });
});

describe("Events", () => {
  const listen = () => {
    const got: Written[] = [];
    const events = new Events((event) => got.push(event), "claude-opus-5-5");
    return { got, events, ui: events.ui({ toolCall() {}, toolResult() {}, notice() {} } as AgentUI) };
  };

  it("holds what a pipe whose reader is behind can't take, every later line behind it, and writes it in order as room comes", () => {
    const { io, got, room } = pipe();
    const lines = new Lines(1, io);
    room(7);
    lines.write("first line\n");
    lines.write("second\n"); // held behind the rest of the first, though the pipe has no room for either
    assert.equal(got(), "first l");
    room(5);
    lines.drain(); // as the retry does
    assert.equal(got(), "first line\ns");
    room(Infinity);
    lines.write("third\n");
    assert.equal(got(), "first line\ns", "the third waits behind the second");
    lines.drain();
    assert.equal(got(), "first line\nsecond\nthird\n");
  });

  it("at the end waits for a reader that takes some, and gives up on one that takes nothing for 5 s", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      // Takes 2 bytes every 4 s: slow, but never 5 s without taking any.
      let next = 0;
      const slow = pipe((now) => (now < next ? 0 : ((next = now + 4000), 2)));
      const lines = new Lines(1, slow.io);
      lines.write("abcdef\n");
      assert.equal(lines.flush(), 0);
      assert.equal(slow.got(), "abcdef\n");
      assert.ok(slow.io.now() >= 12_000, `waited ${slow.io.now()} ms`);
      assert.deepEqual(told, []);

      // Takes 3 bytes, then nothing.
      const stopped = pipe();
      const held = new Lines(1, stopped.io);
      stopped.room(3);
      for (const line of ["one\n", "two\n", "three\n"]) held.write(line);
      assert.equal(held.flush(), 3);
      assert.equal(stopped.got(), "one");
      assert.equal(stopped.io.now(), FLUSH_SECONDS * 1000);
      assert.deepEqual(told, ["The --events reader took nothing for 5 s: 3 events weren't written."]);
    });
  });

  it("writes no more once the reader closed the pipe, says so once, and leaves any other failure to the caller", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      let calls = 0;
      const closed: Io = {
        write: () => {
          calls++;
          throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
        },
        now: () => 0,
        wait: () => {},
      };
      const lines = new Lines(1, closed);
      lines.write("one\n");
      lines.write("two\n");
      assert.equal(lines.flush(), 0);
      assert.equal(calls, 1);
      assert.equal(told.length, 1);
      assert.match(told[0], /no more events/);
      const broken: Io = {
        ...closed,
        write: () => {
          throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
        },
      };
      assert.throws(() => new Lines(1, broken).write("one\n"), /EIO/);
    });
  });

  it("counts the reader gone when a retry's write fails otherwise (EIO, say), rather than throw from its timer", async () => {
    const told: string[] = [];
    await withContext({ silent: true, told: (text) => told.push(text) }, async () => {
      let calls = 0;
      const failing: Io = {
        write: () => {
          if (calls++ === 0) throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });
          throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
        },
        now: () => 0,
        wait: () => {},
      };
      const lines = new Lines(1, failing);
      lines.write("one\n"); // held, and tried again on the timer
      await new Promise((done) => setTimeout(done, 100));
      assert.equal(calls, 2);
      assert.deepEqual(told, ["The --events reader is gone (a write failed: EIO): jig writes no more events, and goes on with the task."]);
      lines.write("two\n");
      assert.equal(lines.flush(), 0);
      assert.equal(calls, 2);
    });
  });

  it("at the end counts the reader gone when a write fails otherwise (EIO, say), rather than throw out of jig's exit", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      let calls = 0;
      const failing: Io = {
        write: () => {
          if (calls++ === 0) throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });
          throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
        },
        now: () => 0,
        wait: () => {},
      };
      const lines = new Lines(1, failing);
      lines.write("one\n"); // held
      lines.write("two\n");
      assert.doesNotThrow(() => lines.flush());
      assert.deepEqual(told, ["The --events reader is gone (a write failed: EIO): 2 events weren't written."]);
    });
  });

  it("after a signal waits 20 s at most in all, though the reader takes some every few seconds", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      let next = 0;
      const slow = pipe((now) => (now < next ? 0 : ((next = now + 4000), 2)));
      const lines = new Lines(1, slow.io);
      lines.write(`${"x".repeat(99)}\n`);
      lines.write("two\n");
      assert.equal(lines.flush(20), 2);
      assert.equal(slow.io.now(), 20_000);
      assert.equal(slow.got(), "x".repeat(12));
      assert.deepEqual(told, ["The --events reader didn't take them all in the 20 s jig gives it after a signal: 2 events weren't written."]);
    });
  });

  it("at a normal end waits 60 s at most in all, though the reader takes some every few seconds", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      let next = 0;
      const slow = pipe((now) => (now < next ? 0 : ((next = now + 4000), 2)));
      const events = new Events("-", "claude-opus-5-5", slow.io);
      events.notice("x".repeat(100));
      assert.equal(events.end("end_turn", 0)?.exitCode, 0);
      assert.equal(slow.io.now(), 60_000);
      assert.equal(slow.got().length, 32);
      assert.deepEqual(told, ["The --events reader didn't take them all in the 60 s jig gives it at a normal end: 2 events weren't written."]);
    });
  });

  it("holds lines up to its limit, drops the events past it but for the end, and says how many it dropped", () => {
    const told: string[] = [];
    withContext({ silent: true, told: (text) => told.push(text) }, () => {
      const stopped = pipe();
      const lines = new Lines(1, stopped.io, 10);
      lines.write("one\n");
      lines.write("two\n");
      lines.write("three\n"); // 14 bytes held: dropped
      lines.write("x\n"); // 10: held
      lines.write("y\n");
      assert.equal(lines.dropped, 2);
      lines.write("end\n", true); // the end goes, however much is held
      stopped.room(Infinity);
      assert.equal(lines.flush(), 0);
      assert.equal(stopped.got(), "one\ntwo\nx\nend\n");
      assert.deepEqual(told, ["The --events reader was too far behind: 2 events weren't written, past the 10 bytes jig holds for it."]);
    });
  });

  it("blanks out a key before it cuts the output, so a key the cut falls in isn't left half there", () => {
    const { got, ui } = listen();
    const key = `sk-${"a1".repeat(20)}`;
    // The cut keeps 1,968 characters from each end: it falls 18 characters into the key, too few to match alone.
    ui.toolResult(`${"x".repeat(1949)} ${key}\n${"y\n".repeat(3000)}`, false, "t1");
    const output = String(got[0].output);
    assert.ok(!output.includes(key.slice(0, 12)), output.slice(1940, 2000));
    assert.equal(got[0].truncated, true);
    assert.ok(output.length <= 4000, `${output.length} characters`);
  });

  it("cuts a long tool call's description to 4,000 characters, and an approval request's to 64,000", () => {
    const { got, events, ui } = listen();
    ui.toolCall("bash", "a".repeat(10_000), "t1");
    ui.toolCall("bash", "ls", "t2");
    events.approvalRequest({ step: 1, id: "ap_1", tool: "edit_file", description: "+".repeat(2_000_000) });
    const [long, short, request] = got;
    assert.ok(String(long.description).length <= 4000, `${String(long.description).length} characters`);
    assert.match(String(long.description), /characters truncated/);
    assert.deepEqual([long.truncated, short.description, short.truncated], [true, "ls", undefined]);
    assert.ok(String(request.description).length <= 64_000, `${String(request.description).length} characters`);
    assert.equal(request.truncated, true);
  });

  it("prices the end by the model the reply names when that has a price, else by jig's own", async () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const replying = (model: string) => (async () => ({ message: { role: "assistant", content: [], usage, model }, malformed: new Map() })) as unknown as CallModel;
    const endOf = async (jigs: string, replies: string[]) => {
      const events = new Events(() => {}, jigs);
      for (const model of replies) await events.meter(replying(model), jigs)([], new AbortController().signal);
      return events.end("done", 0)!.cost;
    };
    // A gateway's alias jig has no price for, served by claude-opus-5-5: $4 for the 1M in, $2 for the 100k out.
    assert.equal(await endOf("claude-fast", ["claude-opus-5-5"]), 6);
    // A reply's model without a price (the fake API's "m", or a dated id) leaves jig's own price.
    assert.equal(await endOf("claude-opus-5-5", ["m"]), 6);
    assert.equal(await endOf("claude-fast", ["m"]), null);
    assert.equal(await endOf("claude-fast", ["constructor"]), null);
  });
  it("prices a step by the model its reply names when that has a price, else by jig's own or the escalation's", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const stepOf = (jigs: string, reply: { served?: string; model?: string }) => {
      const got: Written[] = [];
      const ui = new Events((event) => got.push(event), jigs).ui({ toolCall() {}, toolResult() {}, notice() {} } as AgentUI);
      ui.step!(1, { text: "", usage, ...reply } as Parameters<NonNullable<AgentUI["step"]>>[1]);
      return got[0].cost;
    };
    // $4 for the 1M in and $2 for the 100k out at claude-opus-5-5's price; $2 and $1 at claude-sonnet-5-5's.
    assert.equal(stepOf("claude-fast", { served: "claude-opus-5-5" }), 6);
    assert.equal(stepOf("claude-opus-5-5", { served: "m" }), 6);
    assert.equal(stepOf("claude-fast", { served: "m" }), null);
    assert.equal(stepOf("claude-fast", { served: "constructor" }), null);
    assert.equal(stepOf("claude-fast", { served: "m", model: "claude-sonnet-5-5" }), 3);
    assert.equal(stepOf("claude-fast", { served: "claude-opus-5-5", model: "claude-sonnet-5-5" }), 6);
    // A library's loop that names no served model: priced as before.
    assert.equal(stepOf("claude-opus-5-5", {}), 6);
  });
});

/** jig's CLI against `api`, in the project, with a JIG_HOME of its own and its stdin closed. */
function spawnJig(api: FakeApi, argv: string[], extra: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1", ...extra };
  const child = spawn(process.execPath, [cli, ...argv], { cwd: project, env });
  child.stdin.end();
  return child;
}

/** Runs jig as runJig does, keeping its stdout apart from its stderr. */
async function runSplit(api: FakeApi, argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnJig(api, argv);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  child.stdin.end();
  const code = await new Promise<number | null>((done) => child.on("close", done));
  return { code, stdout, stderr };
}

/**
 * A non-blocking pipe for Lines, on a clock that moves only as Lines waits: it takes what room() allows, or
 * what `taking` gives at each moment, and fails with EAGAIN when it takes nothing.
 */
function pipe(taking?: (now: number) => number) {
  let clock = 0;
  let room = 0;
  const bytes: number[] = [];
  const io: Io = {
    write: (fd, data) => {
      assert.equal(fd, 1);
      const taken = data.subarray(0, Math.min(data.length, taking ? taking(clock) : room));
      if (!taken.length) throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, write"), { code: "EAGAIN" });
      if (!taking) room -= taken.length;
      bytes.push(...taken);
      return taken.length;
    },
    now: () => clock,
    wait: (ms) => void (clock += ms),
  };
  return { io, got: () => Buffer.from(bytes).toString(), room: (bytes: number) => void (room = bytes) };
}

/** Takes 4 KiB of its stdin every half second, until it ends: a reader that is slow, but reads. */
const SLOW_READER = `const b = Buffer.alloc(4096), p = new Int32Array(new SharedArrayBuffer(4)); while (require("node:fs").readSync(0, b) > 0) Atomics.wait(p, 0, 0, 500);`;
