import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { createSandbox } from "../src/sandbox.ts";
import { loadSettings } from "../src/settings.ts";
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
  it("combines the user's and the project's rules", async () => {
    await mkdir(join(dir, ".jig-home"), { recursive: true });
    await writeFile(join(dir, ".jig-home", "settings.json"), JSON.stringify({ deny: ["git push"] }));
    await mkdir(join(dir, ".jig"));
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ deny: ["rm"], allow: ["npm test"], network: true }));
    assert.deepEqual(loadSettings(dir), { allow: ["npm test"], deny: ["git push", "rm"], network: true });
  });

  it("explains a bad settings file", async () => {
    await mkdir(join(dir, ".jig"));
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ deny: "git push" }));
    assert.throws(() => loadSettings(dir), /"deny" must be a list of commands/);
  });
});
