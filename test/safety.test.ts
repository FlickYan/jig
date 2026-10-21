import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { projectKey } from "../src/paths.ts";
import { createSandbox, gitControl, type Sandbox, sandboxProblem, seatbeltProfile } from "../src/sandbox.ts";
import { isTrusted, mergeSettings, needsTrust, readSettings, trust } from "../src/settings.ts";
import { Snapshots } from "../src/snapshots.ts";
import { OutputFiles, runCommand } from "../src/tools/bash.ts";
import { fakeMessagesApi, runJig } from "./fake-api.ts";

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

  it("lets commands read the whole of a long output, but not send jig's writes to it elsewhere", async () => {
    const sandbox = createSandbox(project, { network: false })!;
    const outputs = new OutputFiles();
    const target = join(homedir(), `.jig-sandbox-target-${process.pid}`);
    const fileOf = (out: string) => /The whole output is in (\S+):/.exec(out)?.[1];
    try {
      const path = fileOf(await runCommand("seq 1 20000", project, 20, undefined, sandbox, outputs));
      assert.equal(await run(`wc -l < ${path}`, sandbox), "20000\n\nExit code: 0");
      // Midway, a command puts a symlink to a file it can't write in place of the file jig writes to, which
      // it finds by what it printed (other tests' files may be there too).
      await writeFile(target, "untouched\n");
      const mark = `jig-sandbox-swap-${process.pid}`;
      const swap = `f=$(grep -l ${mark} ${tmpdir()}/jig-output-*.log 2>/dev/null) && rm "$f" && ln -s ${target} "$f" && swapped=$f`;
      const out = await runCommand(`echo ${mark}; seq 1 20000; sleep 0.5; ${swap}; seq 1 20000; echo "swapped $swapped"`, project, 20, undefined, sandbox, outputs);
      assert.match(out, new RegExp(`swapped ${fileOf(out)}\n`));
      assert.equal(await readFile(target, "utf8"), "untouched\n");
    } finally {
      outputs.remove();
      await rm(target, { force: true });
    }
  });

  it("can allow the network", () => {
    const flags = (network: boolean) => createSandbox(project, { network })!.wrap("x").args.join(" ");
    assert.match(flags(false), /deny network|--unshare-net/);
    assert.doesNotMatch(flags(true), /deny network|--unshare-net/);
  });

  it("keeps the repository's git config and hooks read-only, and its git directory in place", async () => {
    const repo = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const config = await readFile(join(repo, ".git", "config"), "utf8");
      const sandbox = createSandbox(repo, { network: false })!;
      const inRepo = (command: string) => runCommand(command, repo, 20, undefined, sandbox);
      // git runs the programs these name outside the sandbox: the user's git later, in a shell prompt say.
      assert.match(await inRepo('git config core.fsmonitor "touch planted"'), /Exit code: [1-9]/);
      assert.match(await inRepo('echo "touch planted" > .git/hooks/pre-commit'), /Exit code: [1-9]/);
      // Moved aside, it could be replaced by a git directory with a config of the command's own.
      assert.match(await inRepo("mv .git .git-moved"), /Exit code: [1-9]/);
      assert.equal(await readFile(join(repo, ".git", "config"), "utf8"), config);
      assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false);
      assert.match(sandbox.limits, /git config and hooks are read-only/);
      // The rest of git works as before.
      const commit = "echo 1 > a.txt && git add a.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s";
      assert.equal(await inRepo(commit), "t\n\nExit code: 0");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("makes a repository's missing hooks directory, so that it is read-only too", async () => {
    const repo = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      git(repo, "init", "-q", "--template="); // no hooks directory, as an empty init.templateDir leaves it too
      const sandbox = createSandbox(repo, { network: false })!;
      assert.match(await runCommand("mkdir -p .git/hooks; echo 'touch planted' > .git/hooks/post-commit", repo, 20, undefined, sandbox), /Exit code: [1-9]/);
      assert.equal(existsSync(join(repo, ".git", "hooks", "post-commit")), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("keeps submodules' git config and hooks read-only, and their git directories in place", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const repo = await repoWithSubmodule(base);
      const sub = join(repo, ".git", "modules", "libs", "s"); // a name with a slash is a directory in modules/
      const config = await readFile(join(sub, "config"), "utf8");
      const sandbox = createSandbox(repo, { network: false })!;
      const inRepo = (command: string) => runCommand(command, repo, 20, undefined, sandbox);
      // The user's git status in the repository runs git in the submodule, and so its fsmonitor.
      assert.match(await inRepo('git -C libs/s config core.fsmonitor "touch planted"'), /Exit code: [1-9]/);
      assert.match(await inRepo('echo "touch planted" > .git/modules/libs/s/hooks/post-commit'), /Exit code: [1-9]/);
      assert.match(await inRepo("mv .git/modules .git/modules-moved"), /Exit code: [1-9]/);
      assert.match(await inRepo("mv .git/modules/libs .git/modules/libs-moved"), /Exit code: [1-9]/);
      assert.equal(await readFile(join(sub, "config"), "utf8"), config);
      assert.equal(existsSync(join(sub, "hooks", "post-commit")), false);
      const commit = "cd libs/s && echo 2 > b.txt && git add b.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s -1";
      assert.equal(await inRepo(commit), "t\n\nExit code: 0");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps a submodule checkout's .git file read-only, and says when a command put another checkout in its place", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const repo = await repoWithSubmodule(base);
      const dotGit = join(await realpath(repo), "libs", "s", ".git");
      const pointer = await readFile(dotGit, "utf8");
      const sandbox = createSandbox(repo, { network: false })!;
      const inRepo = (command: string) => runCommand(command, repo, 20, undefined, sandbox);
      // The user's git status in the repository runs git in the checkout, with the config its .git leads to.
      assert.match(await inRepo(`echo "gitdir: ${tmpdir()}" > libs/s/.git`), /Exit code: [1-9]/);
      assert.equal(await readFile(dotGit, "utf8"), pointer);
      assert.deepEqual(sandbox.gitChanges!(), []);
      // Seatbelt refuses the new .git. bubblewrap can't keep the checkout in place, so the sandbox tells, once.
      await inRepo("mv libs/s libs/s-moved && mkdir libs/s && git init -q libs/s");
      assert.deepEqual(sandbox.gitChanges!(), existsSync(dotGit) ? [dotGit] : []);
      assert.deepEqual(sandbox.gitChanges!(), []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps every linked worktree's files read-only, from the main worktree and from another one", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const main = join(base, "main");
      await mkdir(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "first");
      for (const name of ["wt1", "wt2"]) git(main, "worktree", "add", "-q", "--detach", join(base, name));
      const worktrees = join(await realpath(main), ".git", "worktrees");
      // The user's git in wt1 or wt2 would read the config of a git directory a commondir there points to.
      const sandbox = createSandbox(main, { network: false })!;
      const inMain = (command: string) => runCommand(command, main, 20, undefined, sandbox);
      assert.match(await inMain(`echo ${tmpdir()} > .git/worktrees/wt1/commondir`), /Exit code: [1-9]/);
      assert.match(await inMain("mv .git/worktrees .git/worktrees-moved"), /Exit code: [1-9]/);
      assert.match(await inMain("mv .git/worktrees/wt1 .git/worktrees/wt1-moved"), /Exit code: [1-9]/);
      assert.equal(await readFile(join(worktrees, "wt1", "commondir"), "utf8"), "../..\n");
      // A worktree made in the session is the command's own, and can go again.
      const made = join(tmpdir(), `jig-sandbox-worktree-${process.pid}`);
      assert.equal(await inMain(`git worktree add -q --detach ${made} && git worktree remove ${made} && echo removed`), "removed\n\nExit code: 0");
      const fromWt1 = createSandbox(join(base, "wt1"), { network: false })!;
      const inWt1 = (command: string) => runCommand(command, join(base, "wt1"), 20, undefined, fromWt1);
      assert.match(await inWt1(`echo ${tmpdir()} > ${join(worktrees, "wt2", "commondir")}`), /Exit code: [1-9]/);
      assert.equal(await readFile(join(worktrees, "wt2", "commondir"), "utf8"), "../..\n");
      // Seatbelt refuses a config.worktree that isn't there; bubblewrap can't, so the sandbox tells.
      const config = join(worktrees, "wt2", "config.worktree");
      await inWt1(`printf "[core]\\n" > ${config}`);
      assert.deepEqual(fromWt1.gitChanges!(), existsSync(config) ? [config] : []);
      // The user removes a worktree during the session: commands still run, without binding what is gone.
      git(main, "worktree", "remove", "--force", join(base, "wt2"));
      assert.equal(await inMain("echo still"), "still\n\nExit code: 0");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps a linked worktree's .git file and its files in the git directory read-only", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const main = join(base, "main");
      const worktree = join(base, "wt");
      await mkdir(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "first");
      git(main, "worktree", "add", "-q", "--detach", worktree);
      const own = join(main, ".git", "worktrees", "wt");
      const sandbox = createSandbox(worktree, { network: false })!;
      const inWorktree = (command: string) => runCommand(command, worktree, 20, undefined, sandbox);
      // Either would have the user's git in the worktree read the config of a git directory the command made.
      assert.match(await inWorktree(`echo "gitdir: ${tmpdir()}" > .git`), /Exit code: [1-9]/);
      assert.match(await inWorktree(`echo ${tmpdir()} > ${join(own, "commondir")}`), /Exit code: [1-9]/);
      assert.match(await inWorktree(`mv ${join(main, ".git", "worktrees")} ${join(main, ".git", "worktrees-moved")}`), /Exit code: [1-9]/);
      assert.match(await readFile(join(worktree, ".git"), "utf8"), /worktrees\/wt/);
      assert.equal(await readFile(join(own, "commondir"), "utf8"), "../..\n");
      const commit = "echo 1 > a.txt && git add a.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s -1";
      assert.equal(await inWorktree(commit), "t\n\nExit code: 0");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps a config.worktree read-only, and says when a command made a commondir where there was none", async () => {
    const repo = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      git(repo, "init", "-q");
      await writeFile(join(repo, ".git", "config.worktree"), "");
      const sandbox = createSandbox(repo, { network: false })!;
      const inRepo = (command: string) => runCommand(command, repo, 20, undefined, sandbox);
      assert.match(await inRepo('printf "[core]\\n\\tfsmonitor = touch planted\\n" >> .git/config.worktree'), /Exit code: [1-9]/);
      assert.equal(await readFile(join(repo, ".git", "config.worktree"), "utf8"), "");
      assert.deepEqual(sandbox.gitChanges!(), []);
      // Seatbelt refuses it. bubblewrap can't: binding a path that isn't there creates it, and an empty
      // commondir breaks git. So the sandbox tells, once, that the user's git would read another config.
      await inRepo(`echo ${tmpdir()} > .git/commondir`);
      const commondir = join(await realpath(repo), ".git", "commondir");
      assert.deepEqual(sandbox.gitChanges!(), existsSync(commondir) ? [commondir] : []);
      assert.deepEqual(sandbox.gitChanges!(), []);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns after a task in which a command made a commondir", { skip: process.platform === "darwin" && "Seatbelt refuses to make it" }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const command = `echo ${tmpdir()} > .git/commondir`;
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Tidy up."], { api, cwd: repo });
      assert.equal(code, 0);
      const commondir = join(await realpath(repo), ".git", "commondir");
      assert.match(output, new RegExp(`A command created or changed ${commondir}, .*: git would now read its config from elsewhere`));
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns at the end of a session of a commondir made after the last task, as a job a command left running can", async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const commondir = join(await realpath(repo), ".git", "commondir");
    const api = await fakeMessagesApi((request) => {
      if ((request.messages as unknown[]).length === 1) return [{ text: "Done." }];
      // The /compact after the task, when no task is running: here the test makes the file, as such a job would.
      writeFileSync(commondir, `${tmpdir()}\n`);
      return [{ text: "The user asked to tidy up, and nothing needed it." }];
    });
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5"], { api, cwd: repo, stdin: "Tidy up.\n/compact\n" });
      assert.equal(code, 0, output);
      assert.match(output, new RegExp(`Compacted [^\\n]*\\n[\\s\\S]*A command created or changed ${commondir}, `));
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("the macOS sandbox's profile", () => {
  it("keeps a repository's git config and hooks read-only, and its git directory in place", () => {
    const git = { git: "/p/.git", locked: ["/p/.git/config", "/p/.git/hooks"], fixed: ["/p/.git"] };
    const profile = seatbeltProfile(["/p", "/private/tmp"], false, [], git);
    const locked = profile.indexOf('(deny file-write* (literal "/p/.git/config") (subpath "/p/.git/hooks"))');
    assert.ok(locked > profile.indexOf('(allow file-write* (subpath "/p")'), "after the rule it overrides, since the last rule wins");
    assert.match(profile, /^\(deny file-write-unlink \(literal "\/p\/\.git"\)\)$/m);
    assert.doesNotMatch(seatbeltProfile(["/p"], false, []), /\.git/);
  });

  it("covers submodules, every linked worktree's files, and those that aren't there yet", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    try {
      const repo = await repoWithSubmodule(base);
      for (const name of ["wt", "wt2"]) git(repo, "worktree", "add", "-q", "--detach", join(base, name));
      const [real, wt, wt2] = [await realpath(repo), await realpath(join(base, "wt")), await realpath(join(base, "wt2"))];
      const profile = seatbeltProfile([wt, join(real, ".git")], false, [], gitControl(wt)!);
      const dotGit = join(real, ".git");
      const rule = (kind: string, path: string) => `(${kind} "${path}")`;
      const denied = profile.split("\n").find((line) => line.startsWith("(deny file-write* "))!;
      const own = ["commondir", "gitdir", "config.worktree"].flatMap((name) => [`worktrees/wt/${name}`, `worktrees/wt2/${name}`]);
      const files = ["config", "config.worktree", "commondir", ...own, "modules/libs/s/config", "modules/libs/s/commondir"];
      for (const path of files) assert.ok(denied.includes(rule("literal", join(dotGit, path))), `${path} is read-only`);
      for (const path of ["hooks", "modules/libs/s/hooks"]) assert.ok(denied.includes(rule("subpath", join(dotGit, path))), `${path} is read-only`);
      for (const path of [join(wt, ".git"), join(wt2, ".git"), join(real, "libs", "s", ".git")]) {
        assert.ok(denied.includes(rule("literal", path)), `${path}, a worktree's or a submodule checkout's .git file, is read-only`);
      }
      const fixed = profile.split("\n").find((line) => line.startsWith("(deny file-write-unlink "))!;
      for (const dir of ["", "worktrees", "worktrees/wt", "worktrees/wt2", "modules", "modules/libs", "modules/libs/s"]) {
        assert.ok(fixed.includes(rule("literal", join(dotGit, dir))), `${dir || ".git"} stays in place`);
      }
      assert.equal(gitControl(base), undefined, "outside a repository");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

/** git with an identity, and allowed to clone a submodule from a local path. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository in `base`/repo with one commit and a submodule at libs/s. */
async function repoWithSubmodule(base: string): Promise<string> {
  const [repo, sub] = [join(base, "repo"), join(base, "sub")];
  for (const dir of [repo, sub]) {
    await mkdir(dir);
    git(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "1\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "first");
  }
  git(repo, "submodule", "add", "-q", sub, "libs/s");
  git(repo, "commit", "-qm", "submodule");
  return repo;
}

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

  it("lists the files changed since the last snapshot, for the Stop hooks, and undo still puts them back", async () => {
    await writeFile(join(dir, "keep.txt"), "v1\n");
    await writeFile(join(dir, "gone.txt"), "x\n");
    const snapshots = new Snapshots(dir);
    assert.equal(snapshots.changed(), undefined, "no snapshot yet");
    snapshots.take("task");
    assert.deepEqual(snapshots.changed(), []);
    await writeFile(join(dir, "keep.txt"), "v2\n");
    await rm(join(dir, "gone.txt"));
    await writeFile(join(dir, "new.txt"), "n\n");
    assert.deepEqual(snapshots.changed(), ["gone.txt", "keep.txt", "new.txt"]);
    // Listing them stores nothing: a file the task made (a big one, say) isn't copied into the snapshots.
    const gitDir = join(process.env.JIG_HOME!, "snapshots", projectKey(dir));
    const blob = execFileSync("git", ["hash-object", join(dir, "new.txt")], { encoding: "utf8" }).trim();
    assert.throws(() => execFileSync("git", [`--git-dir=${gitDir}`, "cat-file", "-e", blob], { stdio: "ignore" }));
    assert.deepEqual(snapshots.undo(), { changed: ["gone.txt", "keep.txt"], removed: ["new.txt"] });
    assert.equal(await readFile(join(dir, "gone.txt"), "utf8"), "x\n");
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

  it("checks the size before every snapshot, counting the files already snapshotted", async () => {
    await writeFile(join(dir, "a.bin"), Buffer.alloc(800_000));
    const snapshots = new Snapshots(dir, 1_000_000);
    snapshots.take("t1");
    await writeFile(join(dir, "b.bin"), Buffer.alloc(800_000)); // a dataset the task downloaded, say
    assert.throws(() => snapshots.take("t2"), /2 MB of files that aren't ignored, more than the 1 MB/);
    assert.equal(snapshots.undo(), undefined, "undoing to t1 would undo the next task too");
  });

  it("undo stores nothing the task created, so a big file can't get past the size check", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir, 1_000_000);
    snapshots.take("t");
    await writeFile(join(dir, "data.bin"), Buffer.alloc(2_000_000, 1)); // a dataset the task downloaded, say
    const blob = execFileSync("git", ["hash-object", join(dir, "data.bin")], { encoding: "utf8" }).trim();
    assert.deepEqual(snapshots.undo(), { changed: [], removed: ["data.bin"] });
    assert.equal(existsSync(join(dir, "data.bin")), false);
    const gitDir = join(process.env.JIG_HOME!, "snapshots", projectKey(dir));
    assert.throws(() => execFileSync("git", [`--git-dir=${gitDir}`, "cat-file", "-e", blob], { stdio: "ignore" }));
  });

  it("undo goes another task back after you edit a file in between", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir);
    snapshots.take("t1");
    await writeFile(join(dir, "a.txt"), "2");
    await writeFile(join(dir, "b.txt"), "b");
    snapshots.take("t2");
    snapshots.undo();
    await writeFile(join(dir, "a.txt"), "edited by hand");
    assert.deepEqual(snapshots.undo(), { changed: ["a.txt"], removed: ["b.txt"] });
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "1");
    assert.equal(existsSync(join(dir, "b.txt")), false);
  });

  it("sizes a symlink as git stores it, not what it points to", async () => {
    const project = join(dir, "project");
    await mkdir(join(project, "data"), { recursive: true });
    await writeFile(join(project, "data", "a.txt"), "1");
    await writeFile(join(dir, "big.bin"), Buffer.alloc(3_000_000)); // outside the project
    const snapshots = new Snapshots(project, 1_000_000);
    snapshots.take("t1");
    // A task links in a big file from elsewhere, makes a link that loops, and puts a file where a directory was.
    await symlink(join(dir, "big.bin"), join(project, "big.bin"));
    await symlink("loop", join(project, "loop"));
    await rm(join(project, "data"), { recursive: true });
    await writeFile(join(project, "data"), "2");
    snapshots.take("t2");
    snapshots.take("t3");
    snapshots.undo();
    snapshots.undo();
    assert.deepEqual(snapshots.undo(), { changed: ["data/a.txt"], removed: ["big.bin", "data", "loop"] });
    assert.equal(await readFile(join(project, "data", "a.txt"), "utf8"), "1");
    assert.equal(existsSync(join(dir, "big.bin")), true, "what a link points to is left alone");
  });

  it("doesn't sign its commits or run hooks, whatever the user's git config says", async () => {
    const hooks = join(dir, "global-hooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "post-commit"), `#!/bin/sh\ntouch ${join(dir, "hook-ran")}\n`);
    await chmod(join(hooks, "post-commit"), 0o755);
    // A signer that fails, like an SSH key in a locked password manager.
    await writeFile(join(dir, "gitconfig"), `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${hooks}\n`);
    process.env.GIT_CONFIG_GLOBAL = join(dir, "gitconfig");
    try {
      const project = join(dir, "project");
      await mkdir(project);
      await writeFile(join(project, "a.txt"), "1");
      const snapshots = new Snapshots(project);
      snapshots.take("t");
      await writeFile(join(project, "a.txt"), "2");
      snapshots.undo();
      assert.equal(await readFile(join(project, "a.txt"), "utf8"), "1");
      assert.equal(existsSync(join(dir, "hook-ran")), false);
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
  });

  it("says what went wrong when git fails, and keeps the snapshot to undo again", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir);
    snapshots.take("t");
    await writeFile(join(dir, "a.txt"), "2");
    // Left behind by a git that was killed, or held by another jig in the same project.
    const lock = join(process.env.JIG_HOME!, "snapshots", projectKey(dir), "index.lock");
    await writeFile(lock, "");
    assert.throws(() => snapshots.undo(), { message: /^fatal: Unable to create '.*index\.lock': File exists/ });
    await rm(lock);
    assert.deepEqual(snapshots.undo(), { changed: ["a.txt"], removed: [] });
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "1");
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
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "(", command: "true" }] } }));
    assert.throws(() => readSettings(dir), /\.jig\/settings\.json: the hook matcher "\(" is not a valid regular expression \(Invalid regular expression: .*\)$/);
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", command: "true" }] } }));
    assert.equal(readSettings(dir).project?.settings.hooks[0].matcher, "*", "* is every tool, as in Claude Code");
    await writeFile(join(dir, ".jig", "settings.json"), JSON.stringify({ mcpServers: { db: { args: [] } } }));
    assert.throws(() => readSettings(dir), /MCP server "db" needs a "command"/);
  });

  it("takes Stop hooks, behind the project's trust, and leaves out events jig doesn't have, with a warning", async () => {
    // As settings written for Claude Code can have: the file loads, without those hooks.
    await writeSettings({ hooks: { UserPromptSubmit: [{ command: "./log.sh" }] } }, { hooks: { SessionStart: [{ command: "echo hi" }], Stop: [{ command: "npm test 1>&2 || exit 2" }] } });
    const { user, project, warnings } = readSettings(dir);
    assert.deepEqual(user.hooks, []);
    assert.deepEqual(project!.settings.hooks, [{ event: "Stop", matcher: undefined, command: "npm test 1>&2 || exit 2" }]);
    assert.deepEqual(warnings, [
      `${join(dir, ".jig-home", "settings.json")}: jig has no hook event "UserPromptSubmit", so those hooks don't run (it has PreToolUse, PostToolUse, Stop).`,
      `${join(dir, ".jig", "settings.json")}: jig has no hook event "SessionStart", so those hooks don't run (it has PreToolUse, PostToolUse, Stop).`,
    ]);
    assert.deepEqual(needsTrust(project!.settings), ["run a Stop hook: npm test 1>&2 || exit 2"]);
    assert.deepEqual(mergeSettings(user, project!.settings, false).hooks, []);
    assert.deepEqual(mergeSettings(user, project!.settings, true).hooks, project!.settings.hooks);
  });
});
