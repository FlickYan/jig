import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type FakeApi, fakeMessagesApi, runJig } from "./fake-api.ts";
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
        { task: "Fix the parser.", cwd: project, model: "claude-opus-5-5", limits: { maxSteps: 50, timeLimit: null } },
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
      assert.deepEqual(types(events), ["start", "step", "tool_call", "tool_result", "notice", "text", "notice", "end"]);
      assert.deepEqual(
        ofType(events, "notice").map((event) => event.text),
        ["Out of steps: asking the model where the work stands.", "Stopped after 1 steps (raise the limit with --max-steps)."],
      );
      assert.deepEqual([events[5].step, events[5].text], [1, "Listed the files; the fix is left."]);
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

/** jig's CLI against `api`, in the project, with a JIG_HOME of its own and its stdin closed. */
function spawnJig(api: FakeApi, argv: string[]): ChildProcessWithoutNullStreams {
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const env = { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key", JIG_HOME: join(outside, "home"), NO_COLOR: "1" };
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
