import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { bashTool, runCommand } from "../src/tools/bash.ts";
import { editTool } from "../src/tools/edit.ts";
import { checkInput, truncate, type ToolContext } from "../src/tools/index.ts";
import { readTool } from "../src/tools/read.ts";
import { FileVersions } from "../src/tools/util.ts";
import { writeTool } from "../src/tools/write.ts";

let ctx: ToolContext;
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "jig-test-"));
  ctx = { cwd, versions: new FileVersions() };
});

const read = (path: string, more: object = {}) => readTool.run({ path, ...more }, ctx);
const write = (path: string, content: string) => writeTool.run({ path, content }, ctx);
const edit = (old_string: string, new_string: string, path = "code.js") =>
  editTool.run({ path, old_string, new_string }, ctx);

/** Creates a file behind the tools' back, then lets the model "read" it. */
async function givenFile(path: string, content: string | Buffer): Promise<void> {
  await writeFile(join(cwd, path), content);
  await read(path);
}

describe("read_file", () => {
  it("numbers lines like cat -n", async () => {
    await writeFile(join(cwd, "a.txt"), "one\ntwo\n");
    assert.equal(await read("a.txt"), "     1\tone\n     2\ttwo\n");
  });

  it("reads a page with offset and limit, and says how to continue", async () => {
    await writeFile(join(cwd, "long.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    const out = await read("long.txt", { offset: 3, limit: 2 });
    assert.match(out, /^ {5}3\tline 3\n {5}4\tline 4\n/);
    assert.match(out, /Showed lines 3-4 of 10\. Use offset=5 to continue/);
  });

  it("hides Windows line endings", async () => {
    await writeFile(join(cwd, "win.txt"), "one\r\ntwo\r\n");
    assert.equal(await read("win.txt"), "     1\tone\n     2\ttwo\n");
  });

  it("explains missing files, directories and binary files", async () => {
    await assert.rejects(read("nope.txt"), /File not found: nope\.txt/);
    await mkdir(join(cwd, "dir"));
    await assert.rejects(read("dir"), /is a directory/);
    await writeFile(join(cwd, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await assert.rejects(read("blob.bin"), /binary/);
  });

  it("refuses paths outside the working directory", async () => {
    await assert.rejects(read("../secret.txt"), /outside the working directory/);
    await assert.rejects(read("/etc/hosts"), /outside the working directory/);
  });
});

describe("write_file", () => {
  it("creates parent directories, and overwrites only files it has read", async () => {
    assert.equal(await write("new/dir/f.txt", "hi\n"), "Created new/dir/f.txt (1 line).");
    assert.equal(await write("new/dir/f.txt", "a\nb\n"), "Overwrote new/dir/f.txt (2 lines).");
    assert.equal(await readFile(join(cwd, "new/dir/f.txt"), "utf8"), "a\nb\n");

    await writeFile(join(cwd, "theirs.txt"), "the user's work\n");
    await assert.rejects(write("theirs.txt", "gone\n"), /haven't read theirs\.txt/);
  });

  it("keeps an existing file's CRLF line endings", async () => {
    await givenFile("win.txt", "old\r\n");
    assert.match(await write("win.txt", "a\nb\n"), /kept its CRLF line endings/);
    assert.equal(await readFile(join(cwd, "win.txt"), "utf8"), "a\r\nb\r\n");
  });
});

describe("edit_file", () => {
  it("replaces an exact, unique match", async () => {
    await givenFile("code.js", "const a = 1;\nconst b = 2;\n");
    assert.match(await edit("const b = 2;", "const b = 3;"), /at line 2/);
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), "const a = 1;\nconst b = 3;\n");
    await edit("const a = 1;", "const a = 0;"); // its own write doesn't count as a change by someone else
  });

  it("edits without a read first: the exact match is the check", async () => {
    await writeFile(join(cwd, "code.js"), "x = 1\n");
    assert.match(await edit("x = 1", "x = 2"), /Edited code\.js/);
  });

  it("won't overwrite a file whose current version the model hasn't read", async () => {
    await writeFile(join(cwd, "code.js"), "x = 1\n");
    await read("code.js");
    await writeFile(join(cwd, "code.js"), "x = 10\n"); // someone else edits it
    await utimes(join(cwd, "code.js"), new Date(), new Date(Date.now() + 5000));
    await assert.rejects(write("code.js", "y = 0\n"), /has changed since you last read it/);
  });

  it("rejects a missing or ambiguous match and leaves the file alone", async () => {
    await givenFile("code.js", "x();\nx();\n");
    await assert.rejects(edit("y();", "z();"), /not found/);
    await assert.rejects(edit("x();", "z();"), /occurs 2 times/);
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), "x();\nx();\n");
  });

  it("counts overlapping matches as ambiguous", async () => {
    await givenFile("code.js", "aaa");
    await assert.rejects(edit("aa", "b"), /occurs 2 times/);
  });

  it("inserts new_string literally, even with $& or $1 in it", async () => {
    await givenFile("code.js", "price = 0;\n");
    await edit("price = 0;", 'price = "$&$1";');
    assert.equal(await readFile(join(cwd, "code.js"), "utf8"), 'price = "$&$1";\n');
  });

  it("rejects an empty or unchanged old_string", async () => {
    await assert.rejects(edit("", "x"), /old_string is empty/);
    await assert.rejects(edit("x", "x"), /identical/);
  });

  it("edits files with Windows line endings and keeps them", async () => {
    await givenFile("win.py", "def f():\r\n    return 1\r\n");
    await edit("def f():\n    return 1", "def f():\n    return 2", "win.py");
    assert.equal(await readFile(join(cwd, "win.py"), "utf8"), "def f():\r\n    return 2\r\n");
    // A one-line old_string matches as it is, but the lines its replacement adds must be CRLF too.
    await edit("    return 2", "    x = 2\n    return x", "win.py");
    assert.equal(await readFile(join(cwd, "win.py"), "utf8"), "def f():\r\n    x = 2\r\n    return x\r\n");
  });

  it("counts a file printed with cat as read", async () => {
    await writeFile(join(cwd, "code.js"), "x = 1\n");
    await bashTool.run({ command: "ls && cat -n code.js" }, ctx);
    assert.match(await write("code.js", "x = 2\n"), /Overwrote code\.js/);
  });

  it("points at the nearest match when old_string is not found", async () => {
    await givenFile("code.py", "def f():\n    if x:\n        return 1\n    return 2\n");
    await assert.rejects(edit("if x:\n    return 1", "if x:\n    return 3", "code.py"), /Lines 2-3 match it except for whitespace/);
    await assert.rejects(edit("     2\t    if x:", "y", "code.py"), /line numbers, which read_file only adds/);
    await assert.rejects(edit("def f():\n    return 9", "z", "code.py"), /first line matches line 1/);
  });
});

describe("bash", () => {
  it("returns stdout, stderr and the exit code", async () => {
    const out = await bashTool.run({ command: "echo hello; echo oops >&2; exit 3" }, ctx);
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
