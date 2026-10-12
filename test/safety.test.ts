import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createSandbox, type Sandbox, sandboxProblem } from "../src/sandbox.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust } from "../src/settings.ts";
import { Snapshots } from "../src/snapshots.ts";
import { runCommand } from "../src/tools/bash.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jig-safety-"));
  process.env.JIG_HOME = join(dir, ".jig-home");
});

describe("sandbox", { skip: sandboxProblem() }, () => {
  // A project under the home directory, so "writes only in the project" isn't just the temp-directory rule.
  let project: string;
  before(async () => {
    project = await mkdtemp(join(homedir(), ".jig-sandbox-project-"));
  });
  after(() => rm(project, { recursive: true, force: true }));
  const run = (command: string, sandbox: Sandbox) => runCommand(command, project, 20, undefined, sandbox);
  const denied = /Operation not permitted|Read-only file system/; // Seatbelt, bubblewrap

  it("lets commands write in the project and the temp directories, but nowhere else", async () => {
    const sandbox = createSandbox(project, { network: false })!;
    assert.match(await run("echo ok > inside.txt && cat inside.txt", sandbox), /^ok/);
    assert.match(await run(`echo ok > ${join(tmpdir(), `jig-sandbox-${process.pid}.txt`)} && echo written`, sandbox), /^written/);
    const probe = join(homedir(), `.jig-sandbox-test-${process.pid}`);
    assert.match(await run(`echo bad > ${probe}`, sandbox), denied);
    assert.equal(existsSync(probe), false);
  });

  it("lets commands write in an added directory too", async () => {
    const added = await mkdtemp(join(homedir(), ".jig-sandbox-added-"));
    try {
      const sandbox = createSandbox(project, { network: false, dirs: [added] })!;
      assert.match(await run(`echo ok > ${join(added, "a.txt")} && echo written`, sandbox), /^written/);
      assert.match(sandbox.limits, new RegExp(`inside the project, ${(await realpath(added)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      await rm(added, { recursive: true, force: true });
    }
  });

  it("keeps commands off the network, but not off their own loopback", async () => {
    const sandbox = createSandbox(project, { network: false })!;
    assert.match(await run("curl -sS -m 5 https://example.com", sandbox), /Exit code: [1-9]/);
    // A server and a client in one command, as a test suite starting its own server does.
    const loopback = `node -e "const s = require('net').createServer((c) => c.end('pong')).listen(0, '127.0.0.1', () => require('net').connect(s.address().port, '127.0.0.1').on('data', (d) => { console.log(String(d)); s.close(); }))"`;
    assert.match(await run(loopback, sandbox), /^pong/);
  });

  it("hides the paths it is given from commands, and only those", async () => {
    const hidden = await mkdtemp(join(homedir(), ".jig-sandbox-hidden-"));
    const shown = await mkdtemp(join(homedir(), ".jig-sandbox-shown-"));
    try {
      await writeFile(join(hidden, "answer.txt"), "the hidden answer");
      await writeFile(join(shown, "notes.txt"), "the visible notes");
      await writeFile(join(shown, "key.txt"), "a hidden key");
      const sandbox = createSandbox(project, { network: false, hidden: [hidden, join(shown, "key.txt")] })!;
      // Seatbelt refuses; bubblewrap shows an empty directory and an empty file in their place.
      assert.doesNotMatch(await run(`cat ${join(hidden, "answer.txt")}`, sandbox), /the hidden answer/);
      assert.doesNotMatch(await run(`ls ${hidden}`, sandbox), /answer\.txt/);
      assert.doesNotMatch(await run(`cat ${join(shown, "key.txt")}`, sandbox), /a hidden key/);
      assert.match(await run(`cat ${join(shown, "notes.txt")}`, sandbox), /^the visible notes/);
      assert.match(sandbox.limits, /Some paths are hidden from commands/);
    } finally {
      await rm(hidden, { recursive: true, force: true });
      await rm(shown, { recursive: true, force: true });
    }
  });

  it("can allow the network", () => {
    const flags = (network: boolean) => createSandbox(project, { network })!.wrap("x").args.join(" ");
    assert.match(flags(false), /deny network|--unshare-net/);
    assert.doesNotMatch(flags(true), /deny network|--unshare-net/);
  });
});

describe("snapshots", () => {
  it("undo puts back changed and deleted files and removes new ones, one task at a time", async () => {
    await writeFile(join(dir, "keep.txt"), "v1\n");
    await writeFile(join(dir, "doomed.txt"), "precious\n");
    await writeFile(join(dir, ".gitignore"), "cache/\n");
    const snapshots = new Snapshots(dir);

    snapshots.take("task 1");
    await writeFile(join(dir, "keep.txt"), "v2\n");
    snapshots.take("task 2");
    await writeFile(join(dir, "keep.txt"), "v3\n");
    await writeFile(join(dir, "doomed.txt"), "");
    await mkdir(join(dir, "new", "deep"), { recursive: true });
    await writeFile(join(dir, "new", "deep", "file.py"), "x = 1\n");
    await mkdir(join(dir, "cache"));
    await writeFile(join(dir, "cache", "ignored.bin"), "ignored");

    const restored = snapshots.undo()!;
    assert.deepEqual(restored, { changed: ["doomed.txt", "keep.txt"], removed: ["new/deep/file.py"] });
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "v2\n");
    assert.equal(await readFile(join(dir, "doomed.txt"), "utf8"), "precious\n");
    assert.equal(existsSync(join(dir, "new")), false, "empty directories left by removed files go too");
    assert.equal(existsSync(join(dir, "cache", "ignored.bin")), true, "ignored files are left alone");

    snapshots.undo();
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "v1\n");
    assert.equal(snapshots.undo(), undefined);
  });

  it("refuses projects too big to copy", async () => {
    await writeFile(join(dir, "data.bin"), Buffer.alloc(201_000_000));
    assert.throws(() => new Snapshots(dir).take("t"), /201 MB of files that aren't ignored/);
  });

  it("works outside git and doesn't touch the project's own repository", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir);
    snapshots.take("t");
    await writeFile(join(dir, "a.txt"), "2");
    snapshots.undo();
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "1");
    assert.equal(existsSync(join(dir, ".git")), false);
  });
});

describe("settings", () => {
  async function writeSettings(user: object, project: object) {
    await mkdir(join(dir, ".jig-home"), { recursive: true });
    await writeFile(join(dir, ".jig-home", "settings.json"), JSON.stringify(user));
    await mkdir(join(dir, ".jig"), { recursive: true });
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify(project));
  }

  it("combines the user's and a trusted project's settings", async () => {
    await writeSettings({ deny: ["git push"] }, { deny: ["rm"], allow: ["npm test"], network: true });
    const { user, project } = readSettings(dir);
    assert.deepEqual(mergeSettings(user, project!.settings, true), {
      allow: ["npm test"],
      deny: ["git push", "rm"],
      hiddenPaths: [],
      sandbox: undefined,
      network: true,
      hooks: [],
      mcpServers: {},
    });
  });

  it("uses only the deny rules of a project that isn't trusted", async () => {
    await writeSettings({ allow: ["make"] }, {
      deny: ["rm"],
      allow: ["npm test"],
      sandbox: false,
      hooks: { PreToolUse: [{ matcher: "bash", command: "./check.sh" }] },
      mcpServers: { db: { command: "node", args: ["server.js"] } },
    });
    const { user, project } = readSettings(dir);
    assert.deepEqual(needsTrust(project!.settings), [
      "run a PreToolUse hook: ./check.sh",
      'start the MCP server "db": node server.js',
      "run these commands without asking: npm test",
      "run commands outside the sandbox",
    ]);
    assert.deepEqual(mergeSettings(user, project!.settings, false), { allow: ["make"], deny: ["rm"], hiddenPaths: [], hooks: [], mcpServers: {} });
  });

  it("hides paths whoever's settings name them, trusted or not", async () => {
    await writeSettings({ hiddenPaths: ["~/.ssh"] }, { hiddenPaths: ["/srv/answers"] });
    const { user, project } = readSettings(dir);
    assert.deepEqual(mergeSettings(user, project!.settings, false).hiddenPaths, [join(homedir(), ".ssh"), "/srv/answers"]);
    await writeSettings({}, { hiddenPaths: ["answers"] });
    assert.throws(() => readSettings(dir), /"hiddenPaths" must be a list of absolute paths/);
  });

  it("remembers trust in one version of the project's settings, not in later edits", async () => {
    await writeSettings({}, { allow: ["npm test"] });
    const before = readSettings(dir).project!;
    assert.equal(isTrusted(dir, before), false);
    trust(dir, before);
    assert.equal(isTrusted(dir, readSettings(dir).project!), true);
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ allow: ["npm test", "curl"] }));
    assert.equal(isTrusted(dir, readSettings(dir).project!), false);
  });

  it("explains a bad settings file", async () => {
    await writeSettings({}, { deny: "git push" });
    assert.throws(() => readSettings(dir), /"deny" must be a list of commands/);
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ hooks: { BeforeEverything: [] } }));
    assert.throws(() => readSettings(dir), /unknown hook event "BeforeEverything"/);
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ mcpServers: { db: { args: [] } } }));
    assert.throws(() => readSettings(dir), /MCP server "db" needs a "command"/);
  });
});
