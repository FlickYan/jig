import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentOptions, type Usage } from "../src/agent.ts";
import { compact } from "../src/compact.ts";
import { Conversation } from "../src/conversation.ts";
import { runHooks, runStopHooks } from "../src/hooks.ts";
import { connectMcpServers, type McpServers } from "../src/mcp.ts";
import type { CallModel, ModelTurn } from "../src/model.ts";
import { Permissions } from "../src/permissions.ts";
import { systemPrompt } from "../src/prompt.ts";
import { discoverSkills, frontmatter, skillCatalog, skillTool } from "../src/skills.ts";
import { TOOLS, type Tool, type ToolContext } from "../src/tools/index.ts";
import { subagentTool } from "../src/tools/subagent.ts";
import { FileVersions } from "../src/tools/util.ts";
import { fakeMessagesApi, runJig } from "./fake-api.ts";

type Block = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;
const reply = (content: Block[], stopReason?: Anthropic.Beta.BetaStopReason): ModelTurn => ({
  message: {
    content,
    stop_reason: stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    usage: { input_tokens: 100, output_tokens: 10 },
  } as Anthropic.Beta.BetaMessage,
  malformed: new Map(),
});
const quietUI = { toolCall() {}, toolResult() {}, notice() {} };

/** A fake model that plays back scripted replies (a summary for summary requests) and records what it was sent. */
function fakeModel(replies: ModelTurn[], seen: MessageParam[][] = [], summary = [text("SUMMARY: so far, so good.")]): CallModel {
  return async (messages, _signal, options) => {
    seen.push(structuredClone(messages));
    if (options?.summarize) return reply(summary);
    const next = replies.shift();
    if (!next) throw new Error("the fake model ran out of replies");
    return next;
  };
}

function agentOptions(callModel: CallModel, overrides: Partial<AgentOptions> = {}): AgentOptions {
  return { callModel, tools: TOOLS, cwd: dir, maxSteps: 10, compactAt: 0, authorize: async () => null, ui: quietUI, ...overrides };
}

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, versions: new FileVersions(), ...overrides });
const usage = (): Usage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jig-ext-"));
  process.env.JIG_HOME = join(dir, ".jig-home");
});

async function writeSkill(base: string, name: string, skillMd: string, files: Record<string, string> = {}) {
  const skillDir = join(base, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillMd);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(skillDir, path, ".."), { recursive: true });
    await writeFile(join(skillDir, path), content);
  }
}

describe("skills", () => {
  it("finds skills in the project and the home directory, and the project's win", async () => {
    const home = join(dir, "home");
    await writeSkill(join(dir, ".agents/skills"), "release", "---\nname: release\ndescription: Cut a release.\n---\nProject steps.");
    await writeSkill(join(home, ".claude/skills"), "release", "---\nname: release\ndescription: Old way.\n---\nUser steps.");
    await writeSkill(join(home, ".jig/skills"), "review", "---\nname: review\ndescription: Review a diff.\n---\nLook closely.");
    await writeSkill(join(dir, ".jig/skills"), "broken", "---\nname: broken\n---\nNo description.");

    const { skills, warnings } = discoverSkills(dir, home, { builtin: null });
    assert.deepEqual(skills.map((skill) => [skill.name, skill.description]), [["release", "Cut a release."], ["review", "Review a diff."]]);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join("\n"), /broken.*no description/);
    assert.match(warnings.join("\n"), /"release" in .*\.claude\/skills\/release is hidden/);
  });

  it("puts only names and descriptions in the system prompt", async () => {
    await writeSkill(join(dir, ".jig/skills"), "release", "---\nname: release\ndescription: Cut a release.\n---\nSECRET STEPS");
    const prompt = systemPrompt(dir, { skills: skillCatalog(discoverSkills(dir, join(dir, "home"), { builtin: null }).skills) });
    assert.match(prompt, /<available_skills>\n<skill name="release">Cut a release\.<\/skill>\n<\/available_skills>/);
    assert.doesNotMatch(prompt, /SECRET STEPS/);
  });

  it("loads the instructions on demand, pins them, and lists the skill's files", async () => {
    await writeSkill(join(dir, ".jig/skills"), "release", "---\nname: release\ndescription: Cut a release.\n---\n\nBump the version first.\n", {
      "scripts/bump.sh": "echo bump",
      "references/policy.md": "Never release on Fridays.",
    });
    const tool = skillTool(discoverSkills(dir, join(dir, "home")).skills);
    const pinned = new Map<string, string>();
    const content = await tool.run({ name: "release" }, context({ pin: (key, value) => pinned.set(key, value) }));

    assert.match(content, /^<skill_content name="release">\nBump the version first\./);
    assert.doesNotMatch(content, /description:/);
    assert.match(content, /<skill_resources>\nreferences\/policy\.md\nscripts\/bump\.sh\n<\/skill_resources>/);
    assert.equal(pinned.get("skill:release"), content);
    assert.equal(await tool.run({ name: "release", file: "references/policy.md" }, context()), "Never release on Fridays.");
    await assert.rejects(tool.run({ name: "release", file: "../../../etc/passwd" }, context()), /has no file/);
  });

  it("reads frontmatter leniently", () => {
    assert.deepEqual(frontmatter("---\nname: pdf\ndescription: Use when: forms, tables\n---\nbody"), {
      name: "pdf",
      description: "Use when: forms, tables",
    });
    assert.deepEqual(frontmatter('---\nname: "csv"\ndescription: >\n  Parse CSV files\n  and fix them.\n---\n'), {
      name: "csv",
      description: "Parse CSV files and fix them.",
    });
    assert.deepEqual(frontmatter("no frontmatter here"), {});
  });

  it("keeps the instructions of skills in use through compaction", async () => {
    const conversation = new Conversation(undefined, [{ role: "user", content: "release it" }]);
    conversation.pin("skill:release", "<skill_content>Bump the version first.</skill_content>");
    await compact(conversation, fakeModel([]));
    assert.match(String(conversation.messages[0].content), /SUMMARY.*Still in effect from before the summary:\n\n<skill_content>Bump/s);
  });
});

describe("MCP", () => {
  const fixture = join(import.meta.dirname, "fixtures", "mcp-server.mjs");
  const open: McpServers[] = [];
  const connect = async (servers: Parameters<typeof connectMcpServers>[0]) => {
    const connected = await connectMcpServers(servers, dir);
    open.push(connected);
    return connected;
  };
  const find = (servers: McpServers, name: string) => servers.tools.find((tool) => tool.definition.name === name)!;
  after(() => Promise.all(open.map((servers) => servers.close())));

  it("lists every page of a server's tools, named mcp__<server>__<tool>", async () => {
    const servers = await connect({ test: { command: process.execPath, args: [fixture] } });
    assert.deepEqual(servers.errors, []);
    assert.deepEqual(servers.status, ['MCP server "test": 5 tools']);
    assert.deepEqual(
      servers.tools.map((tool) => [tool.definition.name, tool.kind]),
      [
        ["mcp__test__add", "read"],
        ["mcp__test__fail", "external"],
        ["mcp__test__crash", "external"],
        ["mcp__test__pid", "read"],
        ["mcp__test__slow", "external"],
      ],
    );
    assert.deepEqual(find(servers, "mcp__test__add").definition.input_schema.required, ["a", "b"]);
  });

  it("calls tools, and turns a tool's error into a failed call", async () => {
    const servers = await connect({ test: { command: process.execPath, args: [fixture] } });
    assert.equal(await find(servers, "mcp__test__add").run({ a: 2, b: 3 }, context()), "5");
    await assert.rejects(find(servers, "mcp__test__fail").run({}, context()), /the database is locked/);
  });

  it("starts a server again after it exits", async () => {
    const servers = await connect({ test: { command: process.execPath, args: [fixture] } });
    const pid = await find(servers, "mcp__test__pid").run({}, context());
    await assert.rejects(find(servers, "mcp__test__crash").run({}, context()), /Connection closed/);
    const restarted = await find(servers, "mcp__test__pid").run({}, context());
    assert.match(restarted, /^\d+$/);
    assert.notEqual(restarted, pid);
  });

  it("stops waiting for a call when the task is interrupted", async () => {
    const servers = await connect({ test: { command: process.execPath, args: [fixture] } });
    const started = Date.now();
    await assert.rejects(find(servers, "mcp__test__slow").run({}, context({ signal: AbortSignal.timeout(100) })));
    assert.ok(Date.now() - started < 900, "the call ended before the server answered");
  });

  it("reports a server that fails to start, and carries on with the others", async () => {
    const servers = await connect({
      missing: { command: join(dir, "no-such-server") },
      test: { command: process.execPath, args: [fixture] },
    });
    assert.equal(servers.tools.length, 5);
    assert.match(servers.errors.join(), /The MCP server "missing" failed to start: .*ENOENT/);
  });

  it("adds a hash to tools whose names come out the same, so each call reaches its own server", async () => {
    const servers = await connect({
      "db.prod": { command: process.execPath, args: [fixture], env: { DATABASE: "prod database" } },
      "db prod": { command: process.execPath, args: [fixture], env: { DATABASE: "test database" } },
      test: { command: process.execPath, args: [fixture] },
    });
    const names = servers.tools.map((tool) => tool.definition.name);
    assert.equal(new Set(names).size, 15);
    assert.ok(names.includes("mcp__test__fail"), "a name no other tool has stays as it is");
    // The model tells the two apart by the description, which names the server.
    const fail = (server: string) =>
      servers.tools.find((tool) => /^mcp__db_prod__fail_[0-9a-f]{8}$/.test(tool.definition.name) && tool.definition.description!.includes(`"${server}"`))!;
    await assert.rejects(fail("db.prod").run({}, context()), /the prod database is locked/);
    await assert.rejects(fail("db prod").run({}, context()), /the test database is locked/);
    assert.deepEqual(servers.errors, ['Tools of the MCP servers "db.prod" and "db prod" come out with the same names, so each has a short hash added (/mcp lists them).']);
    assert.equal(servers.renamed.get(fail("db.prod").definition.name)?.was, "mcp__db_prod__fail");
  });

  it("and to tools whose names are cut to the same 64 characters", async () => {
    const servers = await connect({ [`server-${"x".repeat(60)}`]: { command: process.execPath, args: [fixture] } });
    const names = servers.tools.map((tool) => tool.definition.name);
    assert.equal(new Set(names).size, 5);
    assert.ok(names.every((name) => /^mcp__server-x+_[0-9a-f]{8}$/.test(name) && name.length === 64), names.join());
    const add = servers.tools.find((tool) => tool.definition.description!.includes('"add" tool'))!;
    assert.equal(await add.run({ a: 2, b: 3 }, context()), "5");
  });

  it("keeps a deny rule that names the name such tools shared", async () => {
    const home = await mkdtemp(join(tmpdir(), "jig-home-"));
    const server = { command: process.execPath, args: [fixture] };
    await writeFile(join(home, "settings.json"), JSON.stringify({ mcpServers: { "db.prod": server, "db prod": server }, deny: ["mcp__db_prod__add"] }));
    const api = await fakeMessagesApi((request) => {
      const adds = (request.tools as { name: string }[]).map((tool) => tool.name).filter((name) => name.startsWith("mcp__db_prod__add_"));
      return (request.messages as unknown[]).length === 1 ? adds.map((tool) => ({ tool, input: { a: 2, b: 3 } })) : [{ text: "Done." }];
    });
    try {
      const { output } = await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "Add 2 and 3."], { api, cwd: dir, env: { JIG_HOME: home } });
      assert.match(output, /Tools of the MCP servers "db\.prod" and "db prod" come out with the same names/);
      const names = (api.requests[0].tools as { name: string }[]).map((tool) => tool.name);
      assert.equal(new Set(names).size, names.length, "every tool the model is offered has a name of its own");
      const results = JSON.stringify(api.requests[1].messages);
      assert.equal(results.match(/the mcp__db_prod__add_[0-9a-f]{8} tool is denied in jig's settings/g)?.length, 2);
    } finally {
      api.close();
    }
  });

  it("and the hooks whose matcher names that name, before the call and after it", async () => {
    const home = await mkdtemp(join(tmpdir(), "jig-home-"));
    const server = { command: process.execPath, args: [fixture] };
    const hooks = {
      PreToolUse: [{ matcher: "mcp__db_prod__add", command: "echo 'no adding on prod' >&2; exit 2" }],
      PostToolUse: [{ matcher: "mcp__db_prod__pid", command: "echo 'pid checked' >&2; exit 2" }],
    };
    await writeFile(join(home, "settings.json"), JSON.stringify({ mcpServers: { "db.prod": server, "db prod": server }, hooks }));
    const api = await fakeMessagesApi((request) => {
      const calls = (request.tools as { name: string }[]).map((tool) => tool.name).filter((name) => /^mcp__db_prod__(add|pid)_/.test(name));
      const input = (tool: string) => (tool.includes("add") ? { a: 2, b: 3 } : {});
      return (request.messages as unknown[]).length === 1 ? calls.map((tool) => ({ tool, input: input(tool) })) : [{ text: "Done." }];
    });
    try {
      await runJig(["--no-sandbox", "--yes", "--model", "claude-haiku-4-5", "Add 2 and 3."], { api, cwd: dir, env: { JIG_HOME: home } });
      const results = JSON.stringify(api.requests[1].messages);
      assert.equal(results.match(/Blocked by a hook: no adding on prod/g)?.length, 2);
      assert.equal(results.match(/A hook checked this result and reported:\\npid checked/g)?.length, 2);
    } finally {
      api.close();
    }
  });
});

describe("permissions for MCP tools", () => {
  const tool = (name: string, kind: Tool["kind"]) => ({ definition: { name }, kind }) as Tool;
  const merge = tool("mcp__github__merge_pull_request", "external");
  const search = tool("mcp__docs__search", "read");

  it("asks before external tools, refuses them in plan mode, and never asks in auto mode", () => {
    assert.equal(new Permissions("edits", dir, { contained: true }).decide(merge, {}), "ask");
    assert.match((new Permissions("plan", dir).decide(merge, {}) as { refuse: string }).refuse, /plan mode/);
    assert.equal(new Permissions("auto", dir).decide(merge, {}), "allow");
    assert.equal(new Permissions("plan", dir).decide(search, {}), "allow", "read-only tools may run in plan mode");
  });

  it("allows and denies tools by name, and remembers 'always'", () => {
    assert.equal(new Permissions("edits", dir, { allow: [merge.definition.name] }).decide(merge, {}), "allow");
    const denied = new Permissions("auto", dir, { deny: [merge.definition.name, search.definition.name] });
    assert.ok(typeof denied.decide(merge, {}) === "object");
    assert.ok(typeof denied.decide(search, {}) === "object", "deny rules apply to read-only tools too");
    const permissions = new Permissions("edits", dir);
    assert.equal(permissions.alwaysLabel(merge, {}), "the mcp__github__merge_pull_request tool");
    permissions.allowAlways(merge, {});
    assert.equal(permissions.decide(merge, {}), "allow");
  });
});

describe("hooks", () => {
  const preEdit = (command: string) => [{ event: "PreToolUse" as const, matcher: "edit_file|write_file", command }];

  it("blocks a call when a PreToolUse hook exits with code 2, and gives it the call on stdin", async () => {
    const hooks = preEdit(`cat > "$JIG_PROJECT_DIR/call.json"; echo "no edits to $(basename "$JIG_FILE") today" >&2; exit 2`);
    const outcome = await runHooks(hooks, "PreToolUse", { tool: "edit_file", input: { path: "a.txt" } }, dir);
    assert.equal(outcome.block, "no edits to a.txt today");
    const call = JSON.parse(await readFile(join(dir, "call.json"), "utf8"));
    assert.deepEqual([call.event, call.tool, call.input], ["PreToolUse", "edit_file", { path: "a.txt" }]);
  });

  it("matches tool names exactly, as a regular expression", async () => {
    for (const tool of ["read_file", "edit_files"]) {
      const outcome = await runHooks(preEdit("exit 2"), "PreToolUse", { tool, input: {} }, dir);
      assert.equal(outcome.block, undefined, tool);
    }
  });

  it('takes "*" for every tool, as Claude Code does', async () => {
    const outcome = await runHooks([{ event: "PreToolUse", matcher: "*", command: "exit 2" }], "PreToolUse", { tool: "bash", input: {} }, dir);
    assert.equal(outcome.block, "the hook exited with code 2");
  });

  it("keeps jig's API keys out of a hook's environment", async () => {
    const env = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-secret";
    try {
      const outcome = await runHooks(preEdit('echo "key: ${ANTHROPIC_API_KEY:-none}" >&2; exit 2'), "PreToolUse", { tool: "edit_file", input: {} }, dir);
      assert.equal(outcome.block, "key: none");
    } finally {
      process.env = env;
    }
  });

  it("stops a hook that runs too long, or on Ctrl+C, with everything it started", async () => {
    // The job in the background holds stderr open, so jig used to wait for it whatever the timeout.
    const hooks = preEdit(`(sleep 0.5; touch "$JIG_PROJECT_DIR/survived") & sleep 30`);
    const call = { tool: "edit_file", input: {} };
    let started = Date.now();
    const timedOut = await runHooks(hooks, "PreToolUse", call, dir, { timeout: 200 });
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    assert.match(timedOut.warnings.join(), /\(killed: it timed out after 0.2s\)/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    started = Date.now();
    // Two of them: after Ctrl+C the next hook doesn't start, since nothing could stop it once it had.
    const interrupted = await runHooks([...hooks, ...hooks], "PreToolUse", call, dir, { signal: controller.signal });
    assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
    assert.equal(interrupted.warnings.length, 1, "the second hook never started");
    assert.match(interrupted.warnings[0], /\(killed: the user interrupted it\)/);
    await new Promise((done) => setTimeout(done, 1000));
    assert.ok(!existsSync(join(dir, "survived")), "the background jobs were stopped too");
  });

  it("doesn't wait for a job a hook leaves running in the background", async () => {
    const started = Date.now();
    const outcome = await runHooks(preEdit(`sleep 5 & echo "not now" >&2; exit 2`), "PreToolUse", { tool: "edit_file", input: {} }, dir);
    assert.equal(outcome.block, "not now");
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  });

  it("doesn't even wait a moment for a job that holds only a tool hook's stdout, which nothing reads", async () => {
    // Waiting for a background job's last words takes a second; a tool hook's stdout has none to give.
    const started = Date.now();
    const outcome = await runHooks([{ event: "PostToolUse", command: "sleep 5 2>/dev/null &" }], "PostToolUse", { tool: "edit_file", input: {}, output: "ok" }, dir);
    assert.deepEqual(outcome, { warnings: [] });
    assert.ok(Date.now() - started < 800, `${Date.now() - started} ms`);
  });

  it("passes on PostToolUse feedback, and only warns about a hook that fails", async () => {
    const hooks = [
      { event: "PostToolUse" as const, command: "echo 'lint: missing semicolon' >&2; exit 2" },
      { event: "PostToolUse" as const, command: "exit 1" },
      { event: "PreToolUse" as const, command: "echo broken >&2; exit 7" },
    ];
    const post = await runHooks(hooks, "PostToolUse", { tool: "edit_file", input: {}, output: "ok" }, dir);
    assert.equal(post.feedback, "lint: missing semicolon");
    assert.match(post.warnings.join(), /exited with code 1/);
    const pre = await runHooks(hooks, "PreToolUse", { tool: "bash", input: {} }, dir);
    assert.equal(pre.block, undefined);
    assert.match(pre.warnings.join(), /failed: broken/);
  });

  it("keeps only the start and end of a long report, however much a hook prints", async () => {
    // It used to keep all of it and cut it afterwards: half a billion characters crashed jig.
    const hooks = preEdit("echo first >&2; head -c 20000000 /dev/zero | tr '\\0' x >&2; echo >&2; echo last >&2; exit 2");
    const block = (await runHooks(hooks, "PreToolUse", { tool: "edit_file", input: {} }, dir)).block ?? "";
    assert.ok(block.length < 40_000, `${block.length} characters`);
    assert.match(block, /^first\nx{19494}\n\n\[\.\.\. 19961012 characters truncated \.\.\.\]\n\nx{19494}\nlast$/);
  });

  const stop = { task: "fix the tests", last_message: "Done.", stop_hook_active: false, changed_files: ["a.py"] };

  it("keeps the task from ending when a Stop hook exits with code 2 or prints a block decision, and tells it the task", async () => {
    const hooks = [
      { event: "Stop" as const, command: `cat > "$JIG_PROJECT_DIR/stop.json"; echo "$JIG_EVENT: 2 tests failed" >&2; exit 2` },
      { event: "Stop" as const, command: `echo '{"decision": "block", "reason": "lint: a.py:3 unused import"}'` },
      { event: "Stop" as const, command: `echo '{"decision": "block"}'` },
    ];
    const outcome = await runStopHooks(hooks, stop, dir);
    assert.deepEqual(outcome, { warnings: [], block: "Stop: 2 tests failed\nlint: a.py:3 unused import\nthe hook gave no reason" });
    assert.deepEqual(JSON.parse(await readFile(join(dir, "stop.json"), "utf8")), { event: "Stop", ...stop, cwd: dir });
  });

  it("lets the task end when the Stop hooks pass, or fail otherwise, and runs them only then", async () => {
    const hooks = [
      { event: "Stop" as const, matcher: "bash", command: "echo 'all 9 tests passed'" }, // output that isn't a decision, and a matcher, which doesn't apply
      { event: "Stop" as const, command: `echo '{"decision": "approve"}'` },
      { event: "Stop" as const, command: `echo '{"decision": "block"}'; exit 1` },
      { event: "PreToolUse" as const, command: "exit 2" },
    ];
    const outcome = await runStopHooks(hooks, stop, dir);
    assert.deepEqual(outcome, { warnings: [`Hook "echo '{"decision": "block"}'; exit 1" failed: the hook exited with code 1`] });
    const pre = await runHooks([{ event: "Stop", matcher: "*", command: "exit 2" }], "PreToolUse", { tool: "bash", input: {} }, dir);
    assert.equal(pre.block, undefined, "a Stop hook doesn't run around tool calls");
  });

  it("reads a Stop hook's decision whole, with a reason far longer than a command's output is kept", async () => {
    // A failing test log wrapped in JSON. Kept only to a command's 39,000 characters, it couldn't be read, and
    // the task would end as finished; the loop cuts the reason instead.
    const hooks = [{ event: "Stop" as const, command: `printf '{"decision": "block", "reason": "tests failed: '; head -c 3900000 /dev/zero | tr '\\0' x; printf '"}'` }];
    const outcome = await runStopHooks(hooks, stop, dir);
    assert.deepEqual(outcome.warnings, []);
    assert.ok(outcome.block === `tests failed: ${"x".repeat(3_900_000)}`, `${outcome.block?.slice(0, 40)}…, ${outcome.block?.length} characters`);
  });

  it("keeps only the start and end of a Stop hook's stdout past millions of characters, and says when a decision is too long to read", async () => {
    const lots = "head -c 20000000 /dev/zero | tr '\\0' x";
    const hooks = [
      { event: "Stop" as const, command: lots }, // a test runner's report, say: its own business
      { event: "Stop" as const, command: `yes '{"Action":"pass","Package":"example.com/pkg","Test":"TestCase","Elapsed":0.01}' | head -n 80000` }, // go test -json
      { event: "Stop" as const, command: `printf '{"decision": "block", "reason": "'; ${lots}; printf '"}'` },
      { event: "Stop" as const, command: `printf '{"reason": "'; ${lots}; printf '", "decision": "block"}'` }, // the end is kept too
    ];
    const outcome = await runStopHooks(hooks, stop, dir);
    const tooLong = (hook: { command: string }) => `Hook "${hook.command}" printed too much on stdout to read it as a decision`;
    assert.deepEqual(outcome, { warnings: [tooLong(hooks[2]), tooLong(hooks[3])] });
  });

  it("are applied around tool calls by the agent loop", async () => {
    await writeFile(join(dir, "a.txt"), "hello\n");
    const conversation = new Conversation(undefined, [{ role: "user", content: "go" }]);
    const model = fakeModel([
      reply([toolUse("t1", "read_file", { path: "a.txt" }), toolUse("t2", "bash", { command: "echo hi" })]),
      reply([text("Done.")]),
    ]);
    const hooks = {
      before: async (tool: string) => (tool === "bash" ? "no commands today" : null),
      after: async () => "lint: all clear",
    };
    await runAgent(conversation, agentOptions(model, { hooks }));
    const [read, bash] = conversation.messages[2].content as ToolResult[];
    assert.match(String(read.content), /hello\n\nA hook checked this result and reported:\nlint: all clear$/);
    assert.deepEqual([bash.is_error, bash.content], [true, "Blocked by a hook: no commands today"]);
  });

  it("have what they tell the model cut, as a tool's output is", async () => {
    // A hook that prints a whole test log mustn't put megabytes into one result.
    await writeFile(join(dir, "a.txt"), "hello\n");
    const log = "FAIL test_parse\n".repeat(10_000);
    const conversation = new Conversation(undefined, [{ role: "user", content: "go" }]);
    const model = fakeModel([
      reply([toolUse("t1", "read_file", { path: "a.txt" }), toolUse("t2", "bash", { command: "echo hi" })]),
      reply([text("Done.")]),
    ]);
    const hooks = { before: async (tool: string) => (tool === "bash" ? log : null), after: async () => log };
    await runAgent(conversation, agentOptions(model, { hooks }));
    const [read, bash] = conversation.messages[2].content as ToolResult[];
    assert.match(String(read.content), /hello\n\nA hook checked this result and reported:\nFAIL test_parse\n[\s\S]*characters truncated/);
    assert.match(String(bash.content), /^Blocked by a hook: FAIL test_parse\n[\s\S]*characters truncated/);
    for (const result of [read, bash]) assert.ok(String(result.content).length < 41_000, `${String(result.content).length} characters`);
  });
});

describe("subagents", () => {
  const setup = (callModel: CallModel, maxSteps = 5) => ({
    callModel,
    tools: TOOLS.filter((tool) => tool.kind === "read"),
    cwd: dir,
    maxSteps,
    compactAt: 0,
    authorize: async () => null,
    ui: () => quietUI,
  });

  it("research in a conversation of their own and return only the answer", async () => {
    await writeFile(join(dir, "notes.txt"), "the answer is 42\n");
    const seen: MessageParam[][] = [];
    const model = fakeModel([reply([toolUse("s1", "read_file", { path: "notes.txt" })]), reply([text("It's 42 (notes.txt:1).")])], seen);
    const total = usage();
    const answer = await subagentTool(setup(model)).run({ description: "find it", prompt: "What is the answer?" }, context({ usage: total }));

    assert.equal(answer, "It's 42 (notes.txt:1).");
    assert.deepEqual(seen[0], [{ role: "user", content: "What is the answer?" }]);
    assert.match(JSON.stringify(seen[1]), /the answer is 42/);
    assert.deepEqual(total, { input: 200, cacheWrite: 0, cacheRead: 0, output: 20 }, "their tokens count toward the task");
  });

  it("report what they found when they run out of steps", async () => {
    const seen: MessageParam[][] = [];
    const model = fakeModel([reply([toolUse("s1", "glob", { pattern: "*" })])], seen);
    const answer = await subagentTool(setup(model, 1)).run({ description: "look", prompt: "Look around." }, context());

    assert.equal(answer, "SUMMARY: so far, so good.\n\n(The subagent stopped early: max_steps.)");
    const last = seen.at(-1)!.at(-1)!;
    assert.equal(last.role, "user");
    assert.match(JSON.stringify(last.content), /tool_result.*run out of steps/, "the request rides on the tool results");
  });

  it("report what they found when they are stopped for repeating themselves", async () => {
    const seen: MessageParam[][] = [];
    const again = Array.from({ length: 8 }, (_, i) => reply([toolUse(`s${i}`, "glob", { pattern: "*" })]));
    const answer = await subagentTool(setup(fakeModel(again, seen), 10)).run({ description: "look", prompt: "Look around." }, context());

    assert.equal(answer, "SUMMARY: so far, so good.\n\n(The subagent stopped early: loop.)");
    assert.equal(seen.length, 6, "five steps, then the request for what it found");
  });

  it("report what they found when they reply twice with nothing, and are told only that", async () => {
    const seen: MessageParam[][] = [];
    const model = fakeModel([reply([toolUse("s1", "glob", { pattern: "*" })]), reply([]), reply([])], seen);
    const answer = await subagentTool(setup(model)).run({ description: "look", prompt: "Look around." }, context());

    assert.equal(answer, "SUMMARY: so far, so good.\n\n(The subagent stopped early: empty.)");
    // The loop's note after the first empty reply asked it to go on: the request takes its place.
    const request = JSON.stringify(seen.at(-1));
    assert.match(request, /tool_result.*Two of your replies were empty\. Don't call any more tools: reply now with what you found so far/);
    assert.doesNotMatch(request, /continue the task|run out of steps/);
  });

  it("keep the text they gave before replying twice with nothing, when their report has none", async () => {
    const seen: MessageParam[][] = [];
    // Empty, then text cut off at the output limit, then empty when asked to continue it: the run holds that text.
    const model = fakeModel([reply([]), reply([text("PARTIAL: the needle is in hay")], "max_tokens"), reply([])], seen, []);
    const answer = await subagentTool(setup(model)).run({ description: "look", prompt: "Look around." }, context());

    assert.equal(answer, "PARTIAL: the needle is in hay\n\n(The subagent stopped early: empty.)");
    assert.equal(seen.length, 4, "three steps, then the request for what it found");
  });

  it("are asked only for what they found when an empty reply on the last step runs their steps out", async () => {
    const seen: MessageParam[][] = [];
    const answer = await subagentTool(setup(fakeModel([reply([]), reply([])], seen), 2)).run({ description: "look", prompt: "Look around." }, context());

    assert.equal(answer, "SUMMARY: so far, so good.\n\n(The subagent stopped early: max_steps.)");
    assert.deepEqual(seen.at(-1), [{ role: "user", content: [{ type: "text", text: "Look around." }, { type: "text", text: "You have run out of steps. Don't call any more tools: reply now with what you found so far, and what you didn't get to." }] }]);
  });
});

describe("parallel tool calls", () => {
  /** A tool that takes a while, and records how many of its calls ran at the same time. */
  function slowTool(kind: Tool["kind"]) {
    const stats = { running: 0, most: 0 };
    const tool: Tool = {
      definition: { name: "slow", description: "", input_schema: { type: "object", properties: {} } },
      kind,
      describe: () => "",
      async run() {
        stats.most = Math.max(stats.most, ++stats.running);
        await new Promise((done) => setTimeout(done, 50));
        stats.running--;
        return "ok";
      },
    };
    return { tool, stats };
  }

  it("runs calls that only read at the same time, and the rest in order", async () => {
    for (const [kind, expected] of [["read", 3], ["edit", 1]] as const) {
      const { tool, stats } = slowTool(kind);
      // Different inputs: a call identical to an earlier one in the reply wouldn't run.
      const calls = [toolUse("a", "slow", { n: 1 }), toolUse("b", "slow", { n: 2 }), toolUse("c", "slow", { n: 3 })];
      const conversation = new Conversation(undefined, [{ role: "user", content: "go" }]);
      await runAgent(conversation, agentOptions(fakeModel([reply(calls), reply([text("Done.")])]), { tools: [tool] }));
      assert.equal(stats.most, expected, kind);
      const results = conversation.messages[2].content as ToolResult[];
      assert.deepEqual(results.map((result) => result.tool_use_id), ["a", "b", "c"], "results keep the calls' order");
    }
  });
});
