import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eventBytes, MAX_OUTPUTS, OUTPUT_BYTES, OUTPUTS_BYTES, outputProblem, readOutputs } from "../src/outputs.ts";
import { hiddenTest } from "../src/tools/util.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// --outputs' read of the files a task hands back: jig's own, outside the sandbox, of a folder the task's
// commands control, so what matters most here is what it refuses.

let project: string;
let outside: string;

beforeEach(async () => {
  const base = await tempDir("jig-outputs-");
  project = join(base, "app");
  outside = join(base, "out");
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "the service's own\n");
});
afterEach(removeTempDirs);

const one = (path: string, hides?: (real: string) => unknown) => readOutputs(project, [path], hides)[0];

describe("readOutputs", () => {
  it("hands back a file's text, in a folder too, and each path once in the order given", async () => {
    await mkdir(join(project, "dist"));
    await writeFile(join(project, "report.md"), "# Report\n\nAll good: ✓\n");
    await writeFile(join(project, "dist", "out.json"), '{"ok":true}\n');
    await writeFile(join(project, "empty.txt"), "");
    assert.deepEqual(readOutputs(project, ["dist/out.json", "report.md", "dist/out.json", "empty.txt"]), [
      { path: "dist/out.json", text: '{"ok":true}\n' },
      { path: "report.md", text: "# Report\n\nAll good: ✓\n" },
      { path: "empty.txt", text: "" },
    ]);
  });

  it("says missing for a file that isn't there, and not_a_file for a folder", async () => {
    await mkdir(join(project, "dir"));
    await writeFile(join(project, "file"), "x");
    assert.deepEqual(one("nope.txt"), { path: "nope.txt", problem: "missing" });
    assert.deepEqual(one("no/such/folder.txt"), { path: "no/such/folder.txt", problem: "missing" });
    // A file where a folder on the way would be.
    assert.deepEqual(one("file/inner.txt"), { path: "file/inner.txt", problem: "missing" });
    assert.deepEqual(one("dir"), { path: "dir", problem: "not_a_file" });
  });

  it("never reads through a link: to a file outside, to one inside, or a broken one", async () => {
    await writeFile(join(project, "real.txt"), "inside\n");
    await symlink(join(outside, "secret.txt"), join(project, "leak.txt"));
    await symlink("../out/secret.txt", join(project, "relative.txt"));
    await symlink("real.txt", join(project, "alias.txt"));
    await symlink("/dev/zero", join(project, "zeros"));
    await symlink("nowhere", join(project, "broken"));
    for (const path of ["leak.txt", "relative.txt", "alias.txt", "zeros", "broken"]) assert.deepEqual(one(path), { path, problem: "not_a_file" });
    assert.deepEqual(one("real.txt"), { path: "real.txt", text: "inside\n" });
  });

  it("refuses a file reached through a folder that is a link leading out of the project, and reads through one that stays in it", async () => {
    await mkdir(join(project, "real"));
    await writeFile(join(project, "real", "notes.txt"), "kept\n");
    await symlink(outside, join(project, "door"));
    await symlink("real", join(project, "inner"));
    await mkdir(join(project, "deep"));
    await symlink(join(outside), join(project, "deep", "door"));
    assert.deepEqual(one("door/secret.txt"), { path: "door/secret.txt", problem: "not_a_file" });
    assert.deepEqual(one("deep/door/secret.txt"), { path: "deep/door/secret.txt", problem: "not_a_file" });
    assert.deepEqual(one("inner/notes.txt"), { path: "inner/notes.txt", text: "kept\n" });
  });

  it("refuses a path that leads out by its name, whatever is there", async () => {
    for (const path of ["../out/secret.txt", join(outside, "secret.txt"), "/etc/hostname", "", "a\0b", "dir/", "."]) {
      assert.equal((one(path) as { problem?: string }).problem, "not_a_file", JSON.stringify(path));
    }
    assert.match(outputProblem("../x")!, /leads out of the project/);
    assert.match(outputProblem("/etc/passwd")!, /is absolute/);
    assert.match(outputProblem("x".repeat(513))!, /longer than 512/);
    assert.equal(outputProblem("dist/out.json"), undefined);
  });

  it("reads the project by its real path when the project itself is given through a link", async () => {
    await writeFile(join(project, "a.txt"), "a\n");
    const alias = join(outside, "alias");
    await symlink(project, alias);
    assert.deepEqual(readOutputs(alias, ["a.txt"]), [{ path: "a.txt", text: "a\n" }]);
    assert.deepEqual(readOutputs(join(outside, "gone"), ["a.txt"]), [{ path: "a.txt", problem: "missing" }]);
  });

  it("doesn't open a named pipe, a socket or a device: not_a_file, at once", async () => {
    execFileSync("mkfifo", [join(project, "pipe")]);
    await symlink("/dev/null", join(project, "null"));
    // A socket's path has a short limit (about 100 bytes), which a long TMPDIR goes past: left out there.
    const sock = join(project, "sock");
    const server = Buffer.byteLength(sock) < 100 ? createServer() : undefined;
    if (server) await new Promise<void>((done) => server.listen(sock, done));
    try {
      const began = Date.now();
      // A blocking open of the pipe would wait here for a writer that never comes.
      for (const path of ["pipe", "null", ...(server ? ["sock"] : [])]) assert.deepEqual(one(path), { path, problem: "not_a_file" });
      assert.ok(Date.now() - began < 2_000, "the read came back at once");
    } finally {
      if (server) await new Promise((done) => server.close(done));
    }
  });

  it("says too_large for a file over 256 KiB, and reads one of exactly that", async () => {
    await writeFile(join(project, "fits.txt"), "a".repeat(OUTPUT_BYTES));
    await writeFile(join(project, "over.txt"), "a".repeat(OUTPUT_BYTES + 1));
    // The bound is on bytes: 3 for each of these characters.
    await writeFile(join(project, "wide.txt"), "✓".repeat(OUTPUT_BYTES / 3 + 1));
    const [fits, over, wide] = readOutputs(project, ["fits.txt", "over.txt", "wide.txt"]);
    assert.equal((fits as { text: string }).text.length, OUTPUT_BYTES);
    assert.deepEqual(over, { path: "over.txt", problem: "too_large" });
    assert.deepEqual(wide, { path: "wide.txt", problem: "too_large" });
  });

  it("holds all the texts together to 768 KiB as the event's line writes them: the files past it are too_large", async () => {
    for (const name of ["1", "2", "3", "4"]) await writeFile(join(project, name), name.repeat(OUTPUT_BYTES));
    await writeFile(join(project, "small"), "still fits\n");
    const files = readOutputs(project, ["1", "2", "3", "4", "small"]);
    assert.deepEqual(
      files.map((file) => ("problem" in file ? file.problem : file.text.length)),
      [OUTPUT_BYTES, OUTPUT_BYTES, OUTPUT_BYTES, "too_large", "too_large"],
    );
    // JSON's escapes count: 200 KiB of newlines are 400 KiB of the line, so two such files fill it.
    for (const name of ["a", "b"]) await writeFile(join(project, name), "\n".repeat(200 * 1024));
    assert.equal(eventBytes("\n".repeat(200 * 1024)), 400 * 1024);
    assert.deepEqual(
      readOutputs(project, ["a", "b", "small"]).map((file) => "problem" in file && file.problem),
      [false, "too_large", false],
    );
    // Whatever the files hold, the line stays under the mebibyte a runner reads.
    await writeFile(join(project, "bells"), "\x07".repeat(OUTPUT_BYTES));
    const line = JSON.stringify({ files: readOutputs(project, ["1", "2", "bells", "a", "small"]) });
    assert.ok(Buffer.byteLength(line) <= OUTPUTS_BYTES + 1024, `${Buffer.byteLength(line)} bytes`);
    assert.deepEqual(one("bells"), { path: "bells", problem: "too_large" });
  });

  it("says not_text for bytes that aren't UTF-8, and for text with a NUL", async () => {
    await writeFile(join(project, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await writeFile(join(project, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await writeFile(join(project, "nul.txt"), "before\0after");
    // Cut in the middle of a character.
    await writeFile(join(project, "cut.txt"), Buffer.from("✓").subarray(0, 2));
    for (const path of ["latin1.txt", "blob.bin", "nul.txt", "cut.txt"]) assert.deepEqual(one(path), { path, problem: "not_text" });
  });

  it("says hidden for a file in a path the file tools refuse, however it is reached", async () => {
    await mkdir(join(project, "private"));
    await writeFile(join(project, "private", "key.txt"), "k\n");
    await writeFile(join(project, "open.txt"), "o\n");
    await symlink("private", join(project, "way"));
    const hides = hiddenTest([join(project, "private")], [project]);
    assert.deepEqual(readOutputs(project, ["private/key.txt", "way/key.txt", "open.txt"], hides), [
      { path: "private/key.txt", problem: "hidden" },
      { path: "way/key.txt", problem: "hidden" },
      { path: "open.txt", text: "o\n" },
    ]);
  });

  it("says the same for a name that is there and one that isn't, behind a folder link that leads out or into what is hidden", async () => {
    await mkdir(join(project, "kept"));
    await writeFile(join(project, "kept", "db.sqlite"), "x");
    await symlink(outside, join(project, "out"));
    await symlink(join(project, "kept"), join(project, "in"));
    assert.deepEqual([one("out/secret.txt"), one("out/nope")], [{ path: "out/secret.txt", problem: "not_a_file" }, { path: "out/nope", problem: "not_a_file" }]);
    const hides = hiddenTest([join(project, "kept")]);
    assert.deepEqual([one("in/db.sqlite", hides), one("in/nope", hides)], [{ path: "in/db.sqlite", problem: "hidden" }, { path: "in/nope", problem: "hidden" }]);
    // A link that stays in the project and out of what is hidden still tells a missing file from one that is there.
    assert.deepEqual([one("in/db.sqlite"), one("in/nope")], [{ path: "in/db.sqlite", text: "x" }, { path: "in/nope", problem: "missing" }]);
  });

  it("bounds the texts as the event will hold them, after the redaction that can make them longer", async () => {
    // A URL's password is rewritten to [REDACTED], longer than what it stood for.
    const grows = "db://:abc@h\n".repeat(Math.floor(OUTPUT_BYTES / 11) - 1);
    await writeFile(join(project, "big.txt"), grows);
    const [big] = readOutputs(project, ["big.txt"]);
    assert.deepEqual(big, { path: "big.txt", problem: "too_large" });
    const fits = "db://:abc@h\n".repeat(1000);
    for (const name of ["a", "b", "c"]) await writeFile(join(project, name), fits);
    const files = readOutputs(project, ["a", "b", "c"]);
    assert.ok(files.every((file) => "text" in file && file.text.includes("[REDACTED]") && !file.text.includes("abc")), JSON.stringify(files).slice(0, 200));
    assert.ok(Buffer.byteLength(JSON.stringify(files)) < OUTPUTS_BYTES + 4096);
  });

  it("refuses a path the events couldn't hold as it was asked", () => {
    assert.match(outputProblem("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.md") ?? "", /looks like a secret/);
    assert.match(outputProblem("a\ud800.txt") ?? "", /surrogate/);
    assert.equal(outputProblem("report.md"), undefined);
  });

  it("takes at most 20 paths", async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}`);
    assert.equal(readOutputs(project, paths).length, MAX_OUTPUTS);
  });

  it("checks what it opened, not only the name: a folder swapped for a link out, after the look, is refused", async () => {
    // The swap a command still running could make between the look at the name and the open, made here at
    // the one moment the reader gives a test: its hidden test runs after the first look, before the open.
    await mkdir(join(project, "dir"));
    await writeFile(join(project, "dir", "secret.txt"), "the task's own\n");
    let swapped = false;
    const swap = () => {
      if (swapped) return false;
      swapped = true;
      execFileSync("mv", [join(project, "dir"), join(project, "was")]);
      execFileSync("ln", ["-s", outside, join(project, "dir")]);
      return false;
    };
    assert.deepEqual(one("dir/secret.txt", swap), { path: "dir/secret.txt", problem: "not_a_file" });
    assert.ok(swapped);
    // And the last part swapped for a link: O_NOFOLLOW's refusal.
    await writeFile(join(project, "plain.txt"), "plain\n");
    let linked = false;
    const relink = () => {
      if (!linked) {
        linked = true;
        execFileSync("ln", ["-sf", join(outside, "secret.txt"), join(project, "plain.txt")]);
      }
      return false;
    };
    assert.deepEqual(one("plain.txt", relink), { path: "plain.txt", problem: "not_a_file" });
  });

  it("can't tell a hard link from a file, as it is one: what the sandbox is for", async () => {
    // Written down as what happens, not as what is wanted: see the comment at readOutput.
    await link(join(outside, "secret.txt"), join(project, "hard.txt"));
    assert.deepEqual(one("hard.txt"), { path: "hard.txt", text: "the service's own\n" });
  });
});
