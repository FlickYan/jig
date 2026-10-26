import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { globToRegExp, listFiles, searchLimits } from "../src/tools/files.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import type { ToolContext } from "../src/tools/index.ts";
import { FileVersions } from "../src/tools/util.ts";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

afterEach(removeTempDirs);

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

async function project(git: boolean, files = PROJECT): Promise<ToolContext> {
  const cwd = await tempDir("jig-search-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
  if (git) execFileSync("git", ["init", "-q"], { cwd });
  return { cwd, versions: new FileVersions() };
}

/** A git repository with these files, of which `tracked` are added to git's index and the rest aren't. */
async function repository(files: Record<string, string>, tracked: string[]): Promise<ToolContext> {
  const ctx = await project(true, files);
  execFileSync("git", ["add", "--", ...tracked], { cwd: ctx.cwd });
  return ctx;
}

/** Runs fn with the search limits lowered, as if the project were too big to search whole. */
async function withLimits(limits: Partial<typeof searchLimits>, fn: () => Promise<void>): Promise<void> {
  const saved = { ...searchLimits };
  Object.assign(searchLimits, limits);
  try {
    await fn();
  } finally {
    Object.assign(searchLimits, saved);
  }
}

/** A line that the pattern below takes exponentially long to fail on: 2^40 ways to split the a's. */
const SLOW_LINE = `${"a".repeat(40)}!\n`;
const SLOW_PATTERN = "^(\\w+\\s?)+$";

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
    const { files } = await listFiles(cwd);
    assert.ok(files.includes("src/app.py"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/") || f.startsWith("logs/")));
  });

  it("walks directories outside git, still skipping node_modules", async () => {
    const { cwd } = await project(false);
    const { files } = await listFiles(cwd, "src");
    assert.deepEqual(files, ["src/app.py", "src/util/strings.py", "src/util/strings_test.py"]);
  });

  it("doesn't run a program the repository's git config names", async () => {
    const { cwd } = await project(true);
    const outside = await tempDir("jig-fsmonitor-");
    // git runs core.fsmonitor on every ls-files, and a command the model ran may have set it.
    execFileSync("git", ["config", "core.fsmonitor", `env > ${join(outside, "ran")}; false`], { cwd });
    assert.ok((await listFiles(cwd)).files.includes("src/app.py"));
    assert.equal(existsSync(join(outside, "ran")), false);
  });

  it("runs git without jig's API keys", async () => {
    const { cwd } = await project(true);
    const bin = await tempDir("jig-bin-");
    // A git that notes its environment, then runs the real one from the rest of the PATH.
    await writeFile(join(bin, "git"), `#!/bin/sh\nenv > "${bin}/env"\nPATH="\${PATH#*:}" exec git "$@"\n`, { mode: 0o755 });
    const saved = { PATH: process.env.PATH, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.DEEPSEEK_API_KEY = "sk-test-secret";
    try {
      assert.ok((await listFiles(cwd)).files.includes("src/app.py"));
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

  it("skips build/, dist/ and the like only when git doesn't track them, or path names them", async () => {
    const files = { "build/release.sh": "needle\n", "src/target/Target.java": "needle\n", "dist/bundle.js": "needle\n" };
    const ctx = await repository(files, ["build", "src"]);
    assert.deepEqual((await listFiles(ctx.cwd)).files, ["build/release.sh", "src/target/Target.java"]);
    assert.deepEqual((await listFiles(ctx.cwd, "dist")).files, ["dist/bundle.js"]);
    assert.equal(await grepTool.run({ pattern: "needle", path: "build" }, ctx), "build/release.sh:1: needle");
    assert.equal(await globTool.run({ pattern: "**/*.java" }, ctx), "src/target/Target.java");
  });

  it("lists nested repositories with their own git, also when path leads into one", async () => {
    const files = {
      "top.py": "needle\n",
      "vendor/lib/src/x.py": "needle\n", // a clone inside the project
      "vendor/lib/.gitignore": "*.log\n",
      "vendor/lib/src/debug.log": "needle\n",
      "mods/up/lib.py": "needle\n", // a submodule
    };
    const ctx = await repository(files, ["top.py"]);
    await mkdir(join(ctx.cwd, "mods/empty")); // a submodule that was never checked out
    for (const dir of ["vendor/lib", "mods/up"]) execFileSync("git", ["init", "-q"], { cwd: join(ctx.cwd, dir) });
    for (const [n, dir] of ["mods/up", "mods/empty"].entries()) {
      execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${String(n + 1).repeat(40)},${dir}`], { cwd: ctx.cwd });
    }
    assert.deepEqual((await listFiles(ctx.cwd)).files, ["mods/up/lib.py", "top.py", "vendor/lib/.gitignore", "vendor/lib/src/x.py"]);
    assert.equal(await grepTool.run({ pattern: "needle" }, ctx), "mods/up/lib.py:1: needle\ntop.py:1: needle\nvendor/lib/src/x.py:1: needle");
    assert.equal(await grepTool.run({ pattern: "needle", path: "vendor/lib/src" }, ctx), "vendor/lib/src/x.py:1: needle");
    assert.equal(await globTool.run({ pattern: "*.py", path: "mods/up" }, ctx), "mods/up/lib.py");
  });

  it("walks a path git ignores when path names it, all of it but .git, within the same limits", async () => {
    const files = {
      ".gitignore": "node_modules/\nbuild/\nvendor/\n",
      "node_modules/pkg/index.js": "needle\n",
      "node_modules/pkg/dist/index.js": "needle\n", // where most packages keep their code
      "node_modules/pkg/lib/build/util.js": "needle\n",
      "build/out.js": "needle\n",
      "build/new.js": "needle\n",
      "vendor/lib/x.py": "needle\n", // a clone, in a directory git ignores
      "vendor/lib/.gitignore": "*.log\n",
      "vendor/lib/debug.log": "needle\n",
    };
    const ctx = await repository(files, [".gitignore"]);
    execFileSync("git", ["add", "-f", "build/out.js"], { cwd: ctx.cwd });
    execFileSync("git", ["init", "-q"], { cwd: join(ctx.cwd, "vendor/lib") });
    const pkg = ["dist/index.js", "index.js", "lib/build/util.js"].map((file) => `node_modules/pkg/${file}`);
    assert.equal(await grepTool.run({ pattern: "needle", path: "node_modules/pkg" }, ctx), pkg.map((file) => `${file}:1: needle`).join("\n"));
    assert.equal(await globTool.run({ pattern: "*.js", path: "node_modules/pkg" }, ctx), "node_modules/pkg/index.js");
    assert.equal(await globTool.run({ pattern: "**/*.js", path: "node_modules" }, ctx), pkg.join("\n"));
    await withLimits({ files: 1 }, async () => {
      assert.match(await grepTool.run({ pattern: "needle", path: "node_modules" }, ctx), /\(Searched only the first 1 files: the listing stops there\./);
    });
    // A whole search still leaves them out, a directory git tracks files in is git's list, a clone is
    // listed with its own git, and a walk still leaves out .git.
    assert.equal(await grepTool.run({ pattern: "needle" }, ctx), "build/out.js:1: needle");
    assert.equal(await grepTool.run({ pattern: "needle", path: "build" }, ctx), "build/out.js:1: needle");
    assert.equal(await grepTool.run({ pattern: "needle", path: "vendor/lib" }, ctx), "vendor/lib/x.py:1: needle");
    assert.equal(await globTool.run({ pattern: "**/HEAD", path: "vendor" }, ctx), "No files found.");
    // A project, or an --add-dir directory, that an enclosing repository ignores is walked too, as a home
    // directory's git may ignore everything, but its own dist/ and the like are still left out.
    const ignored = join(ctx.cwd, "node_modules/pkg");
    assert.deepEqual((await listFiles(ignored)).files, ["index.js"]);
    const other = await tempDir("jig-search-");
    assert.deepEqual((await listFiles(other, ignored, [ignored])).files, [join(ignored, "index.js")]);
  });

  it("walks the files when git waits on a named pipe a command made, or the task has stopped", async () => {
    // git opens .git/info/exclude (or a .gitignore, or a nested repository's config) and waits for as long
    // as a named pipe is there: grep and glob waited with it, past --time-limit, until jig was killed.
    const ctx = await project(true, { "a.txt": "needle\n", "sub/b.txt": "needle\n" });
    await rm(join(ctx.cwd, ".git", "info", "exclude"), { force: true });
    execFileSync("mkfifo", [join(ctx.cwd, ".git", "info", "exclude")]);
    await withLimits({ seconds: 1 }, async () => {
      assert.deepEqual((await listFiles(ctx.cwd)).files, ["a.txt", "sub/b.txt"]);
    });
    // Stopped by Ctrl+C or the time limit, glob doesn't wait for git, and grep says why it stopped.
    const stopped = { ...ctx, signal: AbortSignal.abort() };
    const start = Date.now();
    assert.equal(await globTool.run({ pattern: "**/*.txt" }, stopped), "a.txt\nsub/b.txt");
    await assert.rejects(grepTool.run({ pattern: "needle" }, stopped), /grep stopped/);
    assert.ok(Date.now() - start < 10_000, `took ${Date.now() - start} ms`);
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

  it("matches include below path, and takes ./ and absolute globs", async () => {
    const ctx = await project(true);
    const strings = "src/util/strings.py:1: def shout(text):";
    assert.equal(await grepTool.run({ pattern: "def", path: "src", include: "util/*.py" }, ctx), strings);
    assert.equal(await grepTool.run({ pattern: "def", path: "src", include: "src/util/*.py" }, ctx), strings, "or below the project");
    assert.equal(await grepTool.run({ pattern: "def", include: "./src/util/*.py" }, ctx), strings);
    assert.equal(await grepTool.run({ pattern: "def", include: join(ctx.cwd, "src/util/*.py") }, ctx), strings);
    assert.equal(await grepTool.run({ pattern: "def", path: "src", include: "./*.py" }, ctx), "src/app.py:3: def main():");
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
    const secrets = await tempDir("jig-hidden-");
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

describe("grep's limits", () => {
  const letters = Object.fromEntries([..."abcdefgh"].map((name) => [`${name}.txt`, `needle ${name}\n`]));

  it("reads only the first files by name when there are too many, and says so", async () => {
    // git lists untracked files before tracked ones, which must not decide which files are searched.
    const ctx = await repository(letters, ["a.txt", "b.txt", "g.txt", "h.txt"]);
    await withLimits({ files: 5 }, async () => {
      const first = [..."abcde"].map((name) => `${name}.txt:1: needle ${name}`).join("\n");
      assert.equal(await grepTool.run({ pattern: "needle" }, ctx), `${first}\n\n(Searched only the first 5 of 8 files. Narrow the search with path or include.)`);
      assert.equal(await grepTool.run({ pattern: "needle h" }, ctx), "No matches in the first 5 of 8 files. Narrow the search with path or include.");
      assert.equal(await grepTool.run({ pattern: "needle h", include: "[f-h].txt" }, ctx), "h.txt:1: needle h");
      assert.equal(await globTool.run({ pattern: "h.*" }, ctx), "h.txt", "glob looks at every file git lists");
    });
  });

  it("leaves hidden files out of the ones it reads, and of the count", async () => {
    const ctx = await repository(letters, ["a.txt"]);
    const secrets = await tempDir("jig-hidden-");
    await writeFile(join(secrets, "key.txt"), "needle secret\n");
    await symlink(join(secrets, "key.txt"), join(ctx.cwd, "b2.txt")); // between b.txt and c.txt by name
    ctx.hidden = [secrets];
    await withLimits({ files: 3 }, async () => {
      const first = [..."abc"].map((name) => `${name}.txt:1: needle ${name}`).join("\n");
      assert.equal(await grepTool.run({ pattern: "needle" }, ctx), `${first}\n\n(Searched only the first 3 of 8 files. Narrow the search with path or include.)`);
    });
    assert.equal(await globTool.run({ pattern: "b*" }, ctx), "b.txt");
  });

  it("says when a walk outside git stopped at the limit", async () => {
    const ctx = await project(false, letters);
    await withLimits({ files: 5 }, async () => {
      assert.match(await grepTool.run({ pattern: "needle" }, ctx), /\n\n\(Searched only the first 5 files: the listing stops there\. Narrow the search with path or include\.\)$/);
      assert.match(await grepTool.run({ pattern: "nothing like this" }, ctx), /^No matches in the first 5 files: the listing stops there\./);
      assert.match(await globTool.run({ pattern: "*.txt" }, ctx), /\n\n\(Looked only at the first 5 files: the listing stops there\. Narrow the search with path\.\)$/);
      assert.match(await globTool.run({ pattern: "*.rs" }, ctx), /^No files found in the first 5 files: the listing stops there\./);
    });
  });

  it("stops a pattern that takes too long, without holding up jig", async () => {
    const ctx = await project(false, { "slow.txt": SLOW_LINE });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const started = Date.now();
    try {
      await withLimits({ seconds: 0.5 }, () =>
        assert.rejects(grepTool.run({ pattern: SLOW_PATTERN }, ctx), /^Error: grep stopped: matching the pattern in slow\.txt \(file 1 of 1\) took over 0\.5s\. A pattern/),
      );
    } finally {
      clearInterval(timer);
    }
    assert.ok(Date.now() - started < 5000);
    assert.ok(ticks >= 5, "jig's own thread went on running");
    assert.equal(await grepTool.run({ pattern: "a!" }, ctx), `slow.txt:1: ${SLOW_LINE.trim()}`);
  });

  it("doesn't stop a search that is slow only because it reads many files", async () => {
    // Reading them all takes several times the limit, as reading from a cold disk can, but none takes long.
    const many = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${String(i).padStart(4, "0")}.txt`, `needle ${i}\n`]));
    const ctx = await project(false, many);
    await withLimits({ seconds: 0.1 }, async () => {
      const found = await grepTool.run({ pattern: "needle" }, ctx);
      assert.match(found, /^f0000\.txt:1: needle 0\n/);
      assert.match(found, /\n\n\(Showed 200 of 1000 matches\. Narrow the search with path or include\.\)$/, "every file was searched");
    });
  });

  it("stops when the user presses Ctrl+C", async () => {
    const ctx = await project(false, { "slow.txt": SLOW_LINE });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(grepTool.run({ pattern: SLOW_PATTERN }, { ...ctx, signal: controller.signal }), /the user interrupted/);
    assert.ok(Date.now() - started < 5000);
  });

  it("says what stopped it, when it wasn't the user (--time-limit)", async () => {
    const ctx = await project(false, { "slow.txt": SLOW_LINE });
    const controller = new AbortController();
    setTimeout(() => controller.abort("the time limit (--time-limit) was reached"), 200);
    await assert.rejects(grepTool.run({ pattern: SLOW_PATTERN }, { ...ctx, signal: controller.signal }), /grep stopped: the time limit \(--time-limit\) was reached\./);
  });
});

describe("glob", () => {
  it("matches paths relative to the search directory", async () => {
    const ctx = await project(true);
    assert.equal(await globTool.run({ pattern: "**/*_test.py" }, ctx), "src/util/strings_test.py");
    assert.equal(await globTool.run({ pattern: "*.py", path: "src/util" }, ctx), "src/util/strings.py\nsrc/util/strings_test.py");
    assert.equal(await globTool.run({ pattern: "*.rs" }, ctx), "No files found.");
  });

  it("takes patterns starting with ./ or the absolute path", async () => {
    const ctx = await project(true);
    const python = "src/app.py\nsrc/util/strings.py\nsrc/util/strings_test.py";
    assert.equal(await globTool.run({ pattern: "src/**/*.py" }, ctx), python);
    assert.equal(await globTool.run({ pattern: "./src/**/*.py" }, ctx), python);
    assert.equal(await globTool.run({ pattern: join(ctx.cwd, "src/**/*.py") }, ctx), python);
    assert.equal(await globTool.run({ pattern: "./*.py", path: "src" }, ctx), "src/app.py");
  });
});
