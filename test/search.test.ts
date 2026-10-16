import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

  it("doesn't run a program the repository's git config names", async () => {
    const { cwd } = await project(true);
    const outside = await mkdtemp(join(tmpdir(), "jig-fsmonitor-"));
    // git runs core.fsmonitor on every ls-files, and a command the model ran may have set it.
    execFileSync("git", ["config", "core.fsmonitor", `env > ${join(outside, "ran")}; false`], { cwd });
    assert.ok((await listFiles(cwd)).includes("src/app.py"));
    assert.equal(existsSync(join(outside, "ran")), false);
  });

  it("runs git without jig's API keys", async () => {
    const { cwd } = await project(true);
    const bin = await mkdtemp(join(tmpdir(), "jig-bin-"));
    // A git that notes its environment, then runs the real one from the rest of the PATH.
    await writeFile(join(bin, "git"), `#!/bin/sh\nenv > "${bin}/env"\nPATH="\${PATH#*:}" exec git "$@"\n`, { mode: 0o755 });
    const saved = { PATH: process.env.PATH, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.DEEPSEEK_API_KEY = "sk-test-secret";
    try {
      assert.ok((await listFiles(cwd)).includes("src/app.py"));
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const env = await readFile(join(bin, "env"), "utf8");
    assert.match(env, /^HOME=/m, "the rest of the environment is still there");
    assert.doesNotMatch(env, /sk-test-secret|DEEPSEEK_API_KEY/);
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

  it("skips files over the size limit, checking the size before reading them", async () => {
    const ctx = await project(false);
    await writeFile(join(ctx.cwd, "big.log"), `needle\n${"x".repeat(6_000_000)}`);
    await writeFile(join(ctx.cwd, "small.txt"), "needle\n");
    assert.equal(await grepTool.run({ pattern: "needle" }, ctx), "small.txt:1: needle");
  });

  it("explains a bad regular expression", async () => {
    const ctx = await project(false);
    await assert.rejects(grepTool.run({ pattern: "(unclosed" }, ctx), /Invalid regular expression/);
  });

  it("follows links out of the project, but not into a hidden path", async () => {
    const ctx = await project(true);
    const secrets = await mkdtemp(join(tmpdir(), "jig-hidden-"));
    await writeFile(join(secrets, "key.txt"), "hello secret\n");
    await symlink(join(secrets, "key.txt"), join(ctx.cwd, "key.txt"));
    await symlink(secrets, join(ctx.cwd, "secrets"));
    assert.equal(await grepTool.run({ pattern: "secret" }, ctx), "key.txt:1: hello secret");
    ctx.hidden = [secrets];
    assert.equal(await grepTool.run({ pattern: "secret" }, ctx), "No matches.");
    await assert.rejects(grepTool.run({ pattern: "secret", path: "secrets" }, ctx), /secrets is hidden by the user's settings/);
    await assert.rejects(globTool.run({ pattern: "*", path: "secrets" }, ctx), /hidden by the user's settings/);
    assert.doesNotMatch(await globTool.run({ pattern: "**" }, ctx), /key\.txt|secrets/);
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
