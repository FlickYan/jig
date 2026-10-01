import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { createSandbox } from "../src/sandbox.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust } from "../src/settings.ts";
import { Snapshots } from "../src/snapshots.ts";
import { runCommand } from "../src/tools/bash.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jig-safety-"));
  process.env.JIG_HOME = join(dir, ".jig-home");
});

describe("sandbox", { skip: process.platform !== "darwin" && "the sandbox is macOS only" }, () => {
  it("lets commands write in the project but nowhere else, and keeps them offline", async () => {
    const sandbox = createSandbox(dir, { network: false })!;
    assert.match(await runCommand("echo ok > inside.txt && cat inside.txt", dir, 10, undefined, sandbox), /^ok/);
    const probe = join(homedir(), `.jig-sandbox-test-${process.pid}`);
    assert.match(await runCommand(`echo bad > ${probe}`, dir, 10, undefined, sandbox), /Operation not permitted/);
    assert.equal(existsSync(probe), false);
    assert.match(await runCommand("curl -sS -m 5 https://example.com", dir, 10, undefined, sandbox), /Exit code: [1-9]/);
  });

  it("can allow the network", async () => {
    assert.doesNotMatch(createSandbox(dir, { network: true })!.wrap("x").args[1], /deny network/);
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
    assert.deepEqual(mergeSettings(user, project!.settings, false), { allow: ["make"], deny: ["rm"], hooks: [], mcpServers: {} });
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
