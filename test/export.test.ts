import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exampleProblems, exportSession } from "../src/export.ts";
import { redactSecrets } from "../src/secrets.ts";
import { sessionsCommand } from "../src/sessions-cli.ts";
import { fakeMessagesApi, runJig } from "./fake-api.ts";

const FAKE_KEY = `sk-test${"0".repeat(24)}`;
const TOOL = { name: "bash", description: "Runs a command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };

async function sessionFile(entries: object[], dir?: string): Promise<string> {
  const file = join(dir ?? (await mkdtemp(join(tmpdir(), "jig-export-"))), "2026-10-11T10-00-00-abcd.jsonl");
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return file;
}

const start = { type: "start", cwd: "/project", model: "deepseek-flash", date: "2026-10-11T10:00:00.000Z", system: "You are a coding agent.", tools: [TOOL] };
const message = (role: "user" | "assistant", content: unknown) => ({ type: "message", message: { role, content } });
const call = (id: string, command: string) => ({ type: "tool_use", id, name: "bash", input: { command } });
const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });

describe("exporting sessions as fine-tuning data", () => {
  it("writes the system prompt, the messages with their tool calls, and the tools", async () => {
    const file = await sessionFile([
      start,
      message("user", "Fix the failing test."),
      message("assistant", [{ type: "thinking", thinking: "Let me look.", signature: "x" }, { type: "text", text: "I'll run the tests." }, call("t1", "npm test")]),
      message("user", [result("t1", "1 failing")]),
      message("assistant", [{ type: "text", text: "Fixed: the test passes now." }]),
    ]);
    const exported = exportSession(file)!;
    assert.equal(exported.complete, true);
    assert.deepEqual(exampleProblems(exported.example), []);
    assert.deepEqual(exported.example, {
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "Fix the failing test." },
        { role: "assistant", content: "I'll run the tests.", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } }] },
        { role: "tool", tool_call_id: "t1", content: "1 failing" },
        { role: "assistant", content: "Fixed: the test passes now." },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "Runs a command.", parameters: TOOL.input_schema } }],
    });
  });

  it("ends at the model's last finished reply, and keeps what compaction left out", async () => {
    const file = await sessionFile([
      start,
      message("user", "First task."),
      message("assistant", [{ type: "text", text: "Done with the first." }]),
      { type: "compaction", messages: [{ role: "user", content: "Summary of the first task." }] },
      message("user", "Second task."),
      message("assistant", [{ type: "text", text: "Done with the second." }]),
      message("user", "A third, never answered."),
      message("assistant", [call("t2", "make")]),
    ]);
    const roles = exportSession(file)!.example.messages.map((m) => `${m.role}: ${m.content}`);
    assert.deepEqual(roles, ["system: You are a coding agent.", "user: First task.", "assistant: Done with the first.", "user: Second task.", "assistant: Done with the second."]);
    assert.equal(exportSession(await sessionFile([start, message("user", "Hello?")])), undefined);
  });

  it("blanks out secrets in any message, keeping the JSON valid", async () => {
    const file = await sessionFile([
      start,
      message("user", "Deploy it."),
      message("assistant", [call("t1", "env")]),
      message("user", [result("t1", `HOME=/home/me\nDEEPSEEK_API_KEY=${FAKE_KEY}\nDB="password: \\"hunter2hunter2\\""`)]),
      message("assistant", [{ type: "text", text: "Deployed." }]),
    ]);
    const exported = exportSession(file)!;
    assert.equal(exported.redacted, 2);
    const text = JSON.stringify(exported.example);
    assert.ok(!text.includes(FAKE_KEY) && !text.includes("hunter2hunter2"));
    assert.match(exported.example.messages[3].content as string, /^HOME=\/home\/me\nDEEPSEEK_API_KEY=\[REDACTED\]\nDB="password: \\"\[REDACTED\]\\""$/);
  });

  it("exports a session from before jig recorded the system prompt and tools, and says so", async () => {
    const { system: _, tools: __, ...old } = start;
    const exported = exportSession(await sessionFile([old, message("user", "Hi."), message("assistant", [{ type: "text", text: "Hello." }])]))!;
    assert.equal(exported.complete, false);
    assert.deepEqual(exported.example, { messages: [{ role: "user", content: "Hi." }, { role: "assistant", content: "Hello." }] });
  });

  it("exports every project's sessions with jig sessions export --all", async () => {
    const home = await mkdtemp(join(tmpdir(), "jig-export-home-"));
    for (const project of ["-a", "-b"]) {
      await mkdir(join(home, "sessions", project), { recursive: true });
      await sessionFile([start, message("user", `Task in ${project}.`), message("assistant", [{ type: "text", text: "Done." }])], join(home, "sessions", project));
    }
    const out = join(home, "examples.jsonl");
    const saved = process.env.JIG_HOME;
    process.env.JIG_HOME = home;
    try {
      sessionsCommand(["export", "--all", "--out", out]);
    } finally {
      if (saved === undefined) delete process.env.JIG_HOME;
      else process.env.JIG_HOME = saved;
    }
    const lines = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.messages[1].content), ["Task in -a.", "Task in -b."]);
  });
});

describe("a session jig saves", () => {
  it("records the system prompt and tools it was given, so it exports whole", async () => {
    const api = await fakeMessagesApi((request) =>
      (request.messages as unknown[]).length === 1 ? [{ text: "I'll look." }, { tool: "bash", input: { command: "echo hi" } }] : [{ text: "It says hi." }],
    );
    try {
      const project = await mkdtemp(join(tmpdir(), "jig-export-project-"));
      const home = await mkdtemp(join(tmpdir(), "jig-export-home-"));
      await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "What does echo hi print?"], { api, cwd: project, env: { JIG_HOME: home } });
      const out = join(home, "examples.jsonl");
      const { output } = await runJig(["sessions", "export", "--out", out], { api, cwd: project, env: { JIG_HOME: home } });
      assert.match(output, /Exported 1 of 1 session to /);
      const [example] = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(exampleProblems(example), []);
      assert.match(example.messages[0].content, /^You are a coding agent/);
      assert.deepEqual(example.messages.slice(1).map((m: { role: string }) => m.role), ["user", "assistant", "tool", "assistant"]);
      assert.deepEqual(example.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), ["bash", "edit_file", "glob", "grep", "read_file", "subagent", "write_file"]);
    } finally {
      api.close();
    }
  });
});

describe("checking examples", () => {
  const tools = [{ type: "function" as const, function: { name: "bash", description: "", parameters: {} } }];
  const calls = (...ids: string[]) => ids.map((id) => ({ id, type: "function" as const, function: { name: "bash", arguments: "{}" } }));

  it("accepts calls answered in order, and finds what a trainer would reject", () => {
    assert.deepEqual(exampleProblems({ messages: [{ role: "user", content: "Go." }, { role: "assistant", content: null, tool_calls: calls("a", "b") }, { role: "tool", tool_call_id: "a", content: "1" }, { role: "tool", tool_call_id: "b", content: "2" }, { role: "assistant", content: "Done." }], tools }), []);
    assert.deepEqual(exampleProblems({ messages: [{ role: "user", content: "Go." }, { role: "assistant", content: null, tool_calls: calls("a", "b") }, { role: "tool", tool_call_id: "a", content: "1" }, { role: "assistant", content: "Done." }], tools }), ["message 3: b got no result"]);
    assert.deepEqual(exampleProblems({ messages: [{ role: "user", content: "Go." }, { role: "tool", tool_call_id: "x", content: "1" }, { role: "assistant", content: null, tool_calls: [{ id: "y", type: "function", function: { name: "rm", arguments: "{}" } }] }], tools }), [
      "message 1: a result for x, which no call before it is waiting for",
      "message 2: a call to rm, which isn't among the tools",
      "it doesn't end with the assistant's reply",
    ]);
  });
});

describe("redacting secrets", () => {
  it("blanks out keys whole, private keys to their end, and only the value of a password", () => {
    assert.deepEqual(redactSecrets(`KEY=${FAKE_KEY} and password: hunter2hunter2, token=short`), { text: "KEY=[REDACTED] and password: [REDACTED], token=short", count: 2 });
    assert.deepEqual(redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter"), { text: "[REDACTED]\nafter", count: 1 });
    assert.deepEqual(redactSecrets("a password field, nothing secret"), { text: "a password field, nothing secret", count: 0 });
    // Code that names a variable token or password isn't a secret, and training on [REDACTED] would teach nonsense.
    const code = "token = token.strip()\ntoken = tokens[index]\npassword = get_password()\ntoken = make_token_v2(x)\nsecret = os.environ['APP_SECRET']";
    assert.deepEqual(redactSecrets(code), { text: code, count: 0 });
    assert.deepEqual(redactSecrets("SECRET=abcdefgh12345678 token: 'Zx81Qw93Lm'"), { text: "SECRET=[REDACTED] token: '[REDACTED]'", count: 2 });
  });
});
