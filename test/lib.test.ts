import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { type Event, runTask, type TaskOptions } from "../src/lib.ts";
import { type FakeApi, fakeMessagesApi, runJig, systemText } from "./fake-api.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// jig as a library: runTask() runs a task in the calling program, as `jig --events` would, and several can
// run at once in one process, each with only its own events, permissions, memories, sessions and stats.

afterEach(removeTempDirs);

/** A project and a jig directory of their own, with the options a test against `api` needs. */
async function setUp(api: FakeApi, options: Partial<TaskOptions> = {}): Promise<{ project: string; home: string; events: Event[]; options: TaskOptions }> {
  const base = await tempDir("jig-lib-");
  const project = join(base, "app");
  const home = join(base, "home");
  await mkdir(project);
  await mkdir(home);
  const events: Event[] = [];
  const onEvent = (event: Event) => events.push(event);
  return { project, home, events, options: { prompt: "Fix it.", cwd: project, home, model: "claude-opus-5-5", baseUrl: api.url, apiKey: "test-key", sandbox: false, onEvent, ...options } };
}

const types = (events: Event[]) => events.map((event) => event.type);
const ofType = (events: Event[], type: string) => events.filter((event) => event.type === type);
/** An event without what differs from one run to the next. */
const steady = ({ ts, seconds, cwd, ...event }: Record<string, unknown>) => (event.type === "start" ? { ...event, cwd: "<project>" } : event);

describe("runTask", () => {
  it("runs a task as jig --events does: the same events, the same end, and the reply's text", async () => {
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 1 ? [{ text: "Let me look." }, { tool: "glob", input: { pattern: "*.py" }, id: "call_glob" }] : [{ text: "Done." }],
    );
    try {
      const { project, events, options } = await setUp(api, { yes: true });
      await writeFile(join(project, "parser.py"), "def parse(text):\n    return text\n");
      const result = await runTask(options);
      assert.deepEqual(types(events), ["start", "step", "text", "tool_call", "tool_result", "step", "text", "end"]);
      assert.deepEqual({ ...result, seconds: 0 }, { stop: "end_turn", exitCode: 0, steps: 2, usage: { input: 20, cacheRead: 0, cacheWrite: 0, output: 10 }, cost: 0.00028, seconds: 0, text: "Done." });
      assert.equal(result.seconds, events.at(-1)!.seconds);

      // The CLI's events for the same task, line for line.
      const file = join(project, "..", "events.jsonl");
      const cli = await runJig(["--no-sandbox", "--yes", "--model", "claude-opus-5-5", "--events", file, "Fix it."], { api, cwd: project });
      assert.equal(cli.code, 0, cli.output);
      const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.deepEqual(events.map(steady), lines.map(steady));
    } finally {
      api.close();
    }
  });

  it("runs tasks at once in one process, each with only its own events, usage, files, environment, memories, sessions and stats", async () => {
    // Task i calls bash i + 1 times, then answers: so i + 2 steps, each 10 tokens in and 5 out. Its commands
    // take a moment, so the three are running at the same time. Task a has one step only: out of steps after
    // its command, while the others still run, it is told so, and they must not be.
    const names = ["a", "b", "c"];
    const order: string[] = [];
    const tasks = await Promise.all(
      names.map(async (name, i) => {
        const api = await fakeMessagesApi((request) => {
          const calls = (request.messages as unknown[]).length >> 1;
          if (calls > i) return [{ text: `Task ${name} is done.` }];
          return [{ tool: "bash", input: { command: `sleep 0.2; echo "$TASK" $((${calls} + 1)) >> who.txt` }, id: `${name}_${calls + 1}` }];
        });
        const env = { ...(process.env as Record<string, string>), TASK: name };
        const set = await setUp(api, {
          prompt: `Do task ${name}.`,
          yes: true,
          env,
          ...(name === "a" && { maxSteps: 1 }),
          onEvent: (event) => (set.events.push(event), order.push(`${name}:${event.type}`)),
        });
        // A memory in task a's jig directory alone, and settings jig warns of in task b's.
        if (name === "a") {
          await mkdir(join(set.home, "memory", "user"), { recursive: true });
          await writeFile(join(set.home, "memory", "user", "tabs.md"), "---\nname: tabs\ndescription: The user indents with tabs.\n---\n");
        }
        if (name === "b") await writeFile(join(set.home, "settings.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
        set.options.stats = join(set.project, "..", "stats.json");
        return { name, api, ...set };
      }),
    );
    try {
      const results = await Promise.all(tasks.map((task) => runTask(task.options)));
      assert.ok(order.indexOf("c:start") < order.indexOf("a:end"), "the three ran at the same time");
      // Task a's one step and its wrap-up call; the others' steps.
      const ends = [{ stop: "max_steps", steps: 1, calls: 2 }, ...[3, 4].map((steps) => ({ stop: "end_turn", steps, calls: steps }))];
      tasks.forEach(({ name, api, home, events }, i) => {
        const { stop, steps, calls } = ends[i];
        assert.deepEqual([results[i].stop, results[i].steps, results[i].usage.input, results[i].text], [stop, steps, 10 * calls, `Task ${name} is done.`]);
        assert.equal(events[0].task, `Do task ${name}.`);
        assert.equal(events.at(-1)!.steps, steps);
        assert.deepEqual(
          ofType(events, "tool_call").map((event) => event.id),
          Array.from({ length: i + 1 }, (_, call) => `${name}_${call + 1}`),
        );
        assert.deepEqual(
          ofType(events, "notice").map((event) => String(event.text).replace(home, "<home>")),
          {
            a: ["Out of steps: asking the model where the work stands.", "Stopped after 1 steps (raise the limit with --max-steps)."],
            b: ['<home>/settings.json: jig has no hook event "SessionStart", so those hooks don\'t run (it has PreToolUse, PostToolUse, Stop).'],
            c: [],
          }[name],
        );
        // Its own API saw only its own task, and only task a's saw the memory.
        assert.equal(api.requests.length, calls);
        for (const request of api.requests) assert.match(JSON.stringify(request.messages), new RegExp(`Do task ${name}\\.`));
        assert.equal(systemText(api.requests[0] as { system: string }).includes("The user indents with tabs."), name === "a");
      });
      assert.ok(order.indexOf("c:start") < order.indexOf("a:notice"), "task a was told after all three had started");
      for (const [i, { name, project, home }] of tasks.entries()) {
        // Its commands ran in its project with its environment.
        assert.equal(await readFile(join(project, "who.txt"), "utf8"), Array.from({ length: i + 1 }, (_, call) => `${name} ${call + 1}\n`).join(""));
        // Its session is in its jig directory, and holds its task alone.
        const [key] = await readdir(join(home, "sessions"));
        const sessions = await readdir(join(home, "sessions", key));
        assert.equal(sessions.length, 1);
        const session = await readFile(join(home, "sessions", key, sessions[0]), "utf8");
        assert.ok(session.includes(`Do task ${name}.`) && !names.some((other) => other !== name && session.includes(`Do task ${other}.`)));
        const stats = JSON.parse(await readFile(join(project, "..", "stats.json"), "utf8"));
        assert.deepEqual([stats.stop, stats.modelCalls, stats.toolCalls.bash], [ends[i].stop, ends[i].calls, i + 1]);
      }
    } finally {
      for (const { api } of tasks) api.close();
    }
  });

  it("asks its approver where the CLI would ask at a terminal, and answers as the terminal's yes, always and no do", async () => {
    // Four commands: denied, allowed once, allowed always (so the fourth, the same program, isn't asked), then done.
    const commands = ["touch denied", "touch once", "touch always", "touch again"];
    const api = await fakeMessagesApi((request) => {
      const calls = (request.messages as unknown[]).length >> 1;
      return calls < commands.length ? [{ tool: "bash", input: { command: commands[calls] } }] : [{ text: "Done." }];
    });
    try {
      const asked: unknown[] = [];
      const answers = [{ decision: "deny" as const }, { decision: "allow" as const }, { decision: "allow" as const, always: true }];
      const { project, events, options } = await setUp(api, { approve: async (request) => (asked.push(request), answers[asked.length - 1]) });
      const result = await runTask(options);
      assert.equal(result.stop, "end_turn");
      assert.deepEqual(asked, [
        { id: "ap_1", step: 1, tool: "bash", description: "touch denied" },
        { id: "ap_2", step: 2, tool: "bash", description: "touch once" },
        { id: "ap_3", step: 3, tool: "bash", description: "touch always" },
      ]);
      assert.deepEqual(
        ["denied", "once", "always", "again"].map((name) => existsSync(join(project, name))),
        [false, true, true, true],
      );
      assert.match(String(ofType(events, "tool_result")[0].output), /The user declined this tool call/);
      // What was asked and answered, as --approve-via's events say it.
      assert.deepEqual(
        ofType(events, "approval_request").map(({ id, step }) => [id, step]),
        [["ap_1", 1], ["ap_2", 2], ["ap_3", 3]],
      );
      assert.deepEqual(
        ofType(events, "approval").map(({ id, decision, always, by }) => [id, decision, always, by]),
        [["ap_1", "deny", false, "api"], ["ap_2", "allow", false, "api"], ["ap_3", "allow", true, "api"]],
      );
    } finally {
      api.close();
    }
  });

  it("without an approver denies what would be asked, as with no terminal, and stops at the third", async () => {
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: { command: "touch made" } }]);
    try {
      const { project, events, options } = await setUp(api);
      const result = await runTask(options);
      assert.deepEqual([result.stop, result.exitCode, result.steps], ["unapproved", 5, 3]);
      assert.equal(existsSync(join(project, "made")), false);
      assert.match(String(ofType(events, "tool_result")[0].output), /Not run: there is no one to approve it/);
      assert.deepEqual([events.at(-1)!.stop, events.at(-1)!.exitCode], ["unapproved", 5]);
    } finally {
      api.close();
    }
  });

  it("stops at its signal, an approver still waiting included, ending interrupted", async () => {
    const api = await fakeMessagesApi(() => [{ tool: "bash", input: { command: "touch made" } }]);
    try {
      const controller = new AbortController();
      let waited: AbortSignal | undefined;
      const approve = (_: unknown, signal: AbortSignal) => {
        waited = signal;
        setTimeout(() => controller.abort(), 50);
        return new Promise<never>(() => {}); // never answers
      };
      const { project, events, options } = await setUp(api, { signal: controller.signal, approve });
      const result = await runTask(options);
      assert.deepEqual([result.stop, result.exitCode], ["interrupted", 130]);
      assert.equal(waited?.aborted, true, "the approver's signal says the wait is over");
      assert.equal(existsSync(join(project, "made")), false);
      assert.deepEqual([events.at(-1)!.type, events.at(-1)!.stop], ["end", "interrupted"]);
    } finally {
      api.close();
    }
  });

  it("ends with an error the API gives, saying what failed, and rejects options that are wrong before it starts", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const api = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests: [], close: () => (server.closeAllConnections(), server.close()) };
    try {
      const { events, options } = await setUp(api);
      const result = await runTask(options);
      assert.deepEqual([result.stop, result.exitCode, result.steps], ["error", 1, 0]);
      assert.match(String(result.error), /^Authentication failed/);
      assert.match(String(ofType(events, "notice").at(-1)!.text), /^Authentication failed/);
      assert.equal(events.at(-1)!.stop, "error");

      events.length = 0;
      await assert.rejects(runTask({ ...options, maxSteps: 0 }), /--max-steps must be a positive integer/);
      await assert.rejects(runTask({ ...options, prompt: " " }), /runTask needs a prompt/);
      assert.deepEqual(events, []);
    } finally {
      api.close();
    }
  });

  it("prints nothing, and leaves the process's signal handlers, exit code and directory alone", async () => {
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 1 ? [{ text: "Looking." }, { tool: "bash", input: { command: "echo out; echo err >&2" } }] : [{ text: "Done." }],
    );
    try {
      const { options } = await setUp(api, { yes: true });
      const lib = pathToFileURL(join(import.meta.dirname, "..", "src", "lib.ts")).href;
      // Only the result is printed, by the program that called runTask.
      const program = `
        const { runTask } = await import(${JSON.stringify(lib)});
        const listeners = () => ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((name) => process.listenerCount(name));
        const before = { listeners: listeners(), cwd: process.cwd() };
        const result = await runTask(${JSON.stringify({ ...options, onEvent: undefined })});
        const after = { listeners: listeners(), cwd: process.cwd(), exitCode: process.exitCode ?? null };
        process.stdout.write(JSON.stringify({ stop: result.stop, before, after }));
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, NO_COLOR: "1" } });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      child.stdin.end();
      assert.equal(await new Promise((done) => child.on("close", done)), 0, stderr);
      assert.equal(stderr, "");
      const { stop, before, after } = JSON.parse(stdout);
      assert.equal(stop, "end_turn");
      assert.deepEqual(after, { ...before, exitCode: null });
    } finally {
      api.close();
    }
  });
});
