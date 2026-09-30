import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { bashTool, runCommand } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { checkInput, truncate } from "../src/tools/index.ts";
import { readTool } from "../src/tools/read.ts";
import { writeTool } from "../src/tools/write.ts";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "jig-test-"));
});

describe("read_file", () => {
  it("numbers lines like cat -n", async () => {
    await writeFile(join(cwd, "a.txt"), "one\ntwo\n");
    assert.equal(await readTool.run({ path: "a.txt" }, { cwd }), "     1\tone\n     2\ttwo\n");
  });

  it("reads a page with offset and limit, and says how to continue", async () => {
    await writeFile(join(cwd, "long.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const out = await readTool.run({ path: "long.txt", offset: 3, limit: 2 }, { cwd });
    assert.match(out, /^ {5}3\tline 3\n {5}4\tline 4\n/);
    assert.match(out, /Showed lines 3-4 of 10\. Use offset=5 to continue/);
  });

  it("explains missing files, directories and binary files", async () => {
    await assert.rejects(readTool.run({ path: "nope.txt" }, { cwd }), /File not found: nope\.txt/);
    await mkdir(join(cwd, "dir"), { recursive: true });
    await assert.rejects(readTool.run({ path: "dir" }, { cwd }), /is a directory/);
    await writeFile(join(cwd, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await assert.rejects(readTool.run({ path: "blob.bin" }, { cwd }), /binary/);
  });

  it("refuses paths outside the working directory", async () => {
    await assert.rejects(readTool.run({ path: "../secret.txt" }, { cwd }), /outside the working directory/);
    await assert.rejects(readTool.run({ path: "/etc/hosts" }, { cwd }), /outside the working directory/);
  });
});

describe("write_file", () => {
  it("creates parent directories and says whether it created or overwrote", async () => {
    const created = await writeTool.run({ path: "new/dir/f.txt", content: "hi\n" }, { cwd });
    assert.equal(created, "Created new/dir/f.txt (1 line).");
    const overwrote = await writeTool.run({ path: "new/dir/f.txt", content: "a\nb\n" }, { cwd });
    assert.equal(overwrote, "Overwrote new/dir/f.txt (2 lines).");
    assert.equal(await readFile(join(cwd, "new/dir/f.txt"), "utf8"), "a\nb\n");
  });
});

describe("edit_file", () => {
  const edit = (old_string: string, new_string: string) =>
    editTool.run({ path: "code.js", old_string, new_string }, { cwd });

  it("replaces an exact, unique match", async () => {
    await writeFile(join(cwd, "code.js"), "const a = 1;\nconst b = 2;\n");
    assert.match(await edit("const b = 2;", "const b = 3;"), /at line 2/);
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
  });

  it("rejects a missing or ambiguous match and leaves the file alone", async () => {
    await writeFile(join(cwd, "code.js"), "x();\nx();\n");
    await assert.rejects(edit("y();", "z();"), /not found/);
    await assert.rejects(edit("x();", "z();"), /occurs 2 times/);
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), "x();\nx();\n");
  });

  it("counts overlapping matches as ambiguous", async () => {
    await writeFile(join(cwd, "code.js"), "aaa");
    await assert.rejects(edit("aa", "b"), /occurs 2 times/);
  });

  it("inserts new_string literally, even with $& or $1 in it", async () => {
    await writeFile(join(cwd, "code.js"), "price = 0;\n");
    await edit("price = 0;", 'price = "$&$1";');
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), 'price = "$&$1";\n');
  });

  it("rejects an empty or unchanged old_string", async () => {
    await assert.rejects(edit("", "x"), /old_string is empty/);
    await assert.rejects(edit("x", "x"), /identical/);
  });
});

describe("bash", () => {
  it("returns stdout, stderr and the exit code", async () => {
    const out = await bashTool.run({ command: "echo hello; echo oops >&2; exit 3" }, { cwd });
    assert.match(out, /hello/);
    assert.match(out, /oops/);
    assert.match(out, /Exit code: 3$/);
  });

  it("runs in the working directory with no stdin", async () => {
    await writeFile(join(cwd, "marker.txt"), "");
    assert.match(await runCommand("ls marker.txt", cwd, 10), /^marker\.txt/);
    assert.match(await runCommand('read line; echo "got [$line]"', cwd, 10), /got \[\]/);
  });

  it("kills the whole process group on timeout", async () => {
    const started = Date.now();
    const out = await runCommand("sleep 30 & echo $! > child.pid; wait", cwd, 1);
    assert.match(out, /Killed: it timed out after 1s/);
    assert.ok(Date.now() - started < 5000);
    const child = Number(await readFile(join(cwd, "child.pid"), "utf8"));
    assert.throws(() => process.kill(child, 0), "the background sleep should be gone too");
  });

  it("stops when the task is interrupted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    assert.match(await runCommand("sleep 30", cwd, 60, controller.signal), /Killed: the user interrupted it/);
  });
});

describe("checkInput", () => {
  it("accepts valid input", () => {
    assert.equal(checkInput(readTool, { path: "a.txt", offset: 2 }), null);
  });

  it("names what is wrong", () => {
    assert.match(checkInput(writeTool, { path: "a.txt" })!, /missing required parameter "content"/);
    assert.match(checkInput(readTool, { path: 42 })!, /"path" must be a string/);
    assert.match(checkInput(readTool, { path: "a", offset: 1.5 })!, /"offset" must be an integer/);
    assert.match(checkInput(readTool, { path: "a", mode: "fast" })!, /unknown parameter "mode"/);
    assert.match(checkInput(readTool, "a.txt")!, /must be a JSON object/);
  });
});

describe("truncate", () => {
  it("keeps the head and the tail", () => {
    const out = truncate(`${"a".repeat(100)}${"b".repeat(100)}`, 50);
    assert.ok(out.startsWith("a".repeat(25)) && out.endsWith("b".repeat(25)));
    assert.match(out, /150 characters truncated/);
    assert.equal(truncate("short", 50), "short");
  });
});
