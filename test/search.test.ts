import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { globToRegExp, listFiles } from "../src/tools/files.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { FileVersions } from "../src/tools/util.ts";

const PROJECT: Record<string, string> = {
  "README.md": "# Demo\n",
  "src/app.py": "import os\n\ndef main():\n    print('Hello')\n",
  "src/util/strings.py": "def shout(text):\n    return text.upper()\n",
  "src/util/strings_test.py": "from strings import shout\n",
  "web/index.ts": "export const greeting = 'hello';\n",
  "node_modules/lib/index.js": "const hello = 1;\n",
  "logs/debug.log": "hello from the log\n",
  ".gitignore": "logs/\n",
};

async function project(git: boolean): Promise<ToolContext> {
  const cwd = await mkdtemp(join(tmpdir(), "jig-search-"));
  for (const [path, content] of Object.entries(PROJECT)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  if (git) execFileSync("git", ["init", "-q"], { cwd });
  return { cwd, versions: new FileVersions() };
}

describe("globToRegExp", () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it("handles *, **, ?, braces and classes", () => {
    assert.ok(matches("*.py", "app.py") && !matches("*.py", "src/app.py"));
    assert.ok(matches("**/*.py", "app.py") && matches("**/*.py", "src/util/strings.py"));
    assert.ok(matches("src/**", "src/a/b.ts") && !matches("src/**", "web/a.ts"));
    assert.ok(matches("file?.txt", "file1.txt") && !matches("file?.txt", "file10.txt"));
    assert.ok(matches("*.{ts,js}", "a.ts") && matches("*.{ts,js}", "a.js") && !matches("*.{ts,js}", "a.py"));
    assert.ok(matches("[ab].md", "a.md") && !matches("[!ab].md", "a.md"));
    assert.ok(matches("a+b(1).txt", "a+b(1).txt"), "regex characters are literal");
  });
});

describe("listFiles", () => {
  it("skips node_modules, and what .gitignore says in a git repository", async () => {
    const { cwd } = await project(true);
    const files = await listFiles(cwd);
    assert.ok(files.includes("src/app.py"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith("logs/")));
  });

  it("walks directories outside git, still skipping node_modules", async () => {
    const { cwd } = await project(false);
    const files = await listFiles(cwd, "src");
    assert.deepEqual(files, ["src/app.py", "src/util/strings.py", "src/util/strings_test.py"]);
  });
});

describe("grep", () => {
  it("finds matching lines as path:line: text", async () => {
    const ctx = await project(true);
    assert.equal(await grepTool.run({ pattern: "def \\w+" }, ctx), "src/app.py:3: def main():\nsrc/util/strings.py:1: def shout(text):");
  });

  it("filters by path, include glob and case", async () => {
    const ctx = await project(true);
    assert.equal(await grepTool.run({ pattern: "hello", ignore_case: true, include: "*.ts" }, ctx), "web/index.ts:1: export const greeting = 'hello';");
    assert.match(await grepTool.run({ pattern: "HELLO", ignore_case: true, path: "src" }, ctx), /^src\/app\.py:4:/);
    assert.equal(await grepTool.run({ pattern: "nothing like this" }, ctx), "No matches.");
  });

  it("explains a bad regular expression", async () => {
    const ctx = await project(false);
    await assert.rejects(grepTool.run({ pattern: "(unclosed" }, ctx), /Invalid regular expression/);
  });
});

describe("glob", () => {
  it("matches paths relative to the search directory", async () => {
    const ctx = await project(true);
    assert.equal(await globTool.run({ pattern: "**/*_test.py" }, ctx), "src/util/strings_test.py");
    assert.equal(await globTool.run({ pattern: "*.py", path: "src/util" }, ctx), "src/util/strings.py\nsrc/util/strings_test.py");
    assert.equal(await globTool.run({ pattern: "*.rs" }, ctx), "No files found.");
  });
});
