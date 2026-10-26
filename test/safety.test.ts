import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
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

  it("hides jig's own directory from commands, but for its skills, whose scripts the model runs", async () => {
    const home = process.env.JIG_HOME!;
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "s.jsonl"), "an earlier session\n");
    const skill = join(home, "skills", "hello");
    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "scripts", "hello.sh"), "echo hello from the skill\n");
    const sandbox = createSandbox(project, { network: false })!;
    assert.doesNotMatch(await run(`cat ${join(home, "sessions", "s.jsonl")}`, sandbox), /an earlier session/);
    assert.doesNotMatch(await run(`ls ${join(home, "sessions")}`, sandbox), /s\.jsonl/);
    assert.match(await run(`bash ${join(skill, "scripts", "hello.sh")}`, sandbox), /^hello from the skill/);
    assert.match(sandbox.limits, /jig's own directory \(its sessions, snapshots and settings\) is hidden from commands, but for its skills/);
    // Here it is in a temp directory, which commands can write in, but not in it: settings there could add hooks.
    await run(`echo '{}' > ${join(home, "settings.json")}`, sandbox);
    assert.equal(existsSync(join(home, "settings.json")), false);
    // A project in it, a skill being written say, stays as it was, its git config read-only too.
    git(skill, "init", "-q");
    const inSkill = createSandbox(skill, { network: false })!;
    assert.match(await runCommand("echo 1 > b.txt && cat b.txt scripts/hello.sh", skill, 20, undefined, inSkill), /^1\necho hello/);
    const config = await readFile(join(skill, ".git", "config"), "utf8");
    assert.match(await runCommand(`printf '[core]\\n\\tfsmonitor = touch planted\\n' >> .git/config`, skill, 20, undefined, inSkill), denied);
    assert.equal(await readFile(join(skill, ".git", "config"), "utf8"), config);
  });

  it("keeps a hidden file out of the snapshots, and those an older jig took out of commands' reach", async () => {
    const app = join(dir, "app");
    await mkdir(app);
    await writeFile(join(app, ".env"), "TOKEN=the-hidden-token\n");
    await writeFile(join(app, "a.txt"), "1\n");
    // jig before this change copied it into every snapshot, where a command could read it back.
    new Snapshots(app).take("an older jig's");
    const home = process.env.JIG_HOME!;
    await writeFile(join(home, "settings.json"), JSON.stringify({ hiddenPaths: [join(app, ".env")] }));
    const store = join(home, "snapshots", projectKey(app));
    const command = `echo ran; cat .env; git --git-dir=${store} log --all -p; git --git-dir=${store} show HEAD:.env`;
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Look around."], { api, cwd: app, env: { JIG_HOME: home } });
      assert.equal(code, 0, output);
      assert.match(JSON.stringify(api.requests[1].messages), /ran\\n/);
      assert.doesNotMatch(JSON.stringify(api.requests[1].messages), /the-hidden-token/);
      // The snapshot taken before the task left it out.
      assert.equal(git(app, `--git-dir=${store}`, "ls-tree", "-r", "--name-only", "HEAD"), "a.txt\n");
    } finally {
      api.close();
    }
  });

  it("lets commands read the whole of a long output, but not send jig's writes to it elsewhere", async () => {
    const sandbox = createSandbox(project, { network: false })!;
    const outputs = new OutputFiles();
    const target = join(homedir(), `.jig-sandbox-target-${process.pid}`);
    const fileOf = (out: string) => /The whole output is in (\S+):/.exec(out)?.[1];
    try {
      const path = fileOf(await runCommand("seq 1 20000", project, 20, undefined, sandbox, outputs));
      // macOS's wc pads the count with spaces.
      assert.match(await run(`wc -l < ${path}`, sandbox), /^ *20000\n\nExit code: 0$/);
      // Midway, a command puts a symlink to a file it can't write in place of the file jig writes to, which
      // it finds by what it printed (other tests' files may be there too, and other users' unreadable ones,
      // which make grep fail though it found the file).
      await writeFile(target, "untouched\n");
      const mark = `jig-sandbox-swap-${process.pid}`;
      const swap = `f=$(grep -l ${mark} ${tmpdir()}/jig-output-*.log 2>/dev/null); [ -n "$f" ] && rm "$f" && ln -s ${target} "$f" && swapped=$f`;
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

  it("keeps a git directory made with --separate-git-dir read-only too, though it has no .git in its path", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const [work, gitDir] = [join(base, "work"), join(base, "gitdirs", "work")]; // as dotfile managers set up
      for (const path of [work, dirname(gitDir)]) await mkdir(path);
      git(work, "init", "-q", `--separate-git-dir=${gitDir}`);
      const config = await readFile(join(gitDir, "config"), "utf8");
      const sandbox = createSandbox(work, { network: false })!;
      const inWork = (command: string) => runCommand(command, work, 20, undefined, sandbox);
      assert.match(await inWork('git config core.fsmonitor "touch planted"'), /Exit code: [1-9]/);
      assert.match(await inWork(`echo "touch planted" > ${join(gitDir, "hooks", "pre-commit")}`), /Exit code: [1-9]/);
      assert.match(await inWork(`echo "gitdir: ${tmpdir()}" > .git`), /Exit code: [1-9]/);
      assert.equal(await readFile(join(gitDir, "config"), "utf8"), config);
      assert.equal(existsSync(join(gitDir, "hooks", "pre-commit")), false);
      const commit = "echo 1 > a.txt && git add a.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s";
      assert.equal(await inWork(commit), "t\n\nExit code: 0");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("stops looking for the repository where git does: at a bare one, and at GIT_CEILING_DIRECTORIES", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    const ceilings = process.env.GIT_CEILING_DIRECTORIES;
    try {
      // A home directory's dotfiles repository, with a server's bare repository and a project below it.
      git(base, "init", "-q");
      git(base, "init", "-q", "--bare", "srv/r.git");
      for (const dir of ["srv/r.git/hooks", "proj"]) await mkdir(join(base, dir), { recursive: true });
      const planted = join(base, ".git", "planted");
      const plant = async (from: string) => {
        const cwd = join(base, from);
        return runCommand(`echo planted > ${planted}`, cwd, 20, undefined, createSandbox(cwd, { network: false })!);
      };
      // git takes the bare repository for the one it is in, not base's.
      for (const from of ["srv/r.git", "srv/r.git/hooks"]) assert.match(await plant(from), denied, `from ${from}`);
      // The server's own hooks stay writable, as setting them up can be the task, and nothing of base's is in it.
      const server = join(base, "srv", "r.git");
      const inServer = createSandbox(server, { network: false })!;
      assert.equal(await runCommand("echo 'exit 0' > hooks/post-receive && echo set", server, 20, undefined, inServer), "set\n\nExit code: 0");
      assert.equal(inServer.gitChanges, undefined);
      // Told to stop at base, git finds no repository from proj.
      process.env.GIT_CEILING_DIRECTORIES = base;
      assert.match(await plant("proj"), denied, "from proj");
      assert.equal(existsSync(planted), false);
    } finally {
      if (ceilings === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = ceilings;
      await rm(base, { recursive: true, force: true });
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

  it("keeps a submodule checkout's .git read-only from the directory holding it, though a command made that look bare", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const repo = await repoWithSubmodule(base);
      // jig runs in libs, which holds the checkout libs/s: the user's git status in repo runs git in it.
      const libs = join(repo, "libs");
      const dotGit = join(await realpath(libs), "s", ".git");
      const pointer = await readFile(dotGit, "utf8");
      const session = () => {
        const sandbox = createSandbox(libs, { network: false })!;
        return { sandbox, inLibs: (command: string) => runCommand(command, libs, 20, undefined, sandbox) };
      };
      // A command in an earlier session wrote a config there that says it is bare. git takes that for no
      // repository, and goes on to repo's: so does jig, which locks repo's files and lets git work as before.
      await writeFile(join(libs, "config"), "[core]\n\tbare = true\n");
      assert.equal(git(libs, "rev-parse", "--is-bare-repository").trim(), "false");
      const first = session();
      assert.match(await first.inLibs(`echo "gitdir: ${tmpdir()}" > s/.git`), denied);
      assert.match(await first.inLibs(`printf '[core]\\n\\tfsmonitor = touch planted\\n' >> ../.git/config`), denied);
      const commit = "cd s && echo 2 > b.txt && git add b.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s -1";
      assert.equal(await first.inLibs(commit), "t\n\nExit code: 0");
      // With a HEAD, objects and refs too, git takes it for a bare repository, and so does jig. The checkout's
      // .git, which is repo's, stays read-only all the same, and repo's git directory isn't made writable.
      assert.equal(await first.inLibs("git init -q --bare . && echo made"), "made\n\nExit code: 0");
      assert.equal(git(libs, "rev-parse", "--is-bare-repository").trim(), "true");
      const { sandbox, inLibs } = session();
      assert.match(await inLibs(`echo "gitdir: ${tmpdir()}" > s/.git`), denied);
      assert.match(await inLibs("echo planted > ../.git/planted"), denied);
      assert.equal(await readFile(dotGit, "utf8"), pointer);
      assert.equal(existsSync(join(repo, ".git", "planted")), false);
      // The model is told so, and not that the bare repository's own config and hooks are read-only.
      assert.match(sandbox.limits, /Some git files of the repository around this one are read-only/);
      assert.doesNotMatch(sandbox.limits, /The repository's git config and hooks are read-only/);
      // From a subdirectory of libs too, where the bare repository, writable as well, is above the project.
      const deep = join(libs, "deep");
      await mkdir(deep);
      const inDeep = createSandbox(deep, { network: false })!;
      assert.match(await runCommand(`echo "gitdir: ${tmpdir()}" > ../s/.git`, deep, 20, undefined, inDeep), denied);
      assert.equal(await readFile(dotGit, "utf8"), pointer);
      // Seatbelt refuses a new .git there. bubblewrap can't keep the checkout in place, so the sandbox tells.
      await inLibs("mv s s-moved && mkdir s && git init -q s");
      assert.deepEqual(sandbox.gitChanges!(), existsSync(dotGit) ? [dotGit] : []);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps a submodule checkout's .git read-only from the directory holding it, though a command made a repository there", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const repo = await repoWithSubmodule(base);
      const libs = join(repo, "libs");
      const real = await realpath(libs);
      const dotGit = join(real, "s", ".git");
      const pointer = await readFile(dotGit, "utf8");
      // Making a repository can be the task, so neither sandbox refuses it, but the sandbox tells.
      const first = createSandbox(libs, { network: false })!;
      assert.equal(await runCommand("git init -q && echo made", libs, 20, undefined, first), "made\n\nExit code: 0");
      assert.deepEqual(first.gitChanges!(), [join(real, ".git")]);
      // The next session there takes libs for the repository, as git does, and repo's .git for the checkout
      // in it stays read-only: the user's git status in repo still runs git in the checkout.
      const next = createSandbox(libs, { network: false })!;
      const inLibs = (command: string) => runCommand(command, libs, 20, undefined, next);
      assert.match(await inLibs(`echo "gitdir: ${tmpdir()}" > s/.git`), denied);
      assert.equal(await readFile(dotGit, "utf8"), pointer);
      // repo's git directory isn't made writable, and libs's own repository works as any other.
      assert.match(await inLibs("echo planted > ../.git/planted"), denied);
      const commit = "echo 1 > b.txt && git add b.txt && git -c user.name=t -c user.email=t@localhost commit -qm t && git log --format=%s -1";
      assert.equal(await inLibs(commit), "t\n\nExit code: 0");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps the files of a repository around one a command made read-only in a temp directory, and in an added one", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    const added = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      // In a temp directory, which commands can write, around a bare repository a command made in libs.
      const repo = await repoWithSubmodule(base);
      const libs = join(repo, "libs");
      git(libs, "init", "-q", "--bare", ".");
      const config = await readFile(join(repo, ".git", "config"), "utf8");
      const inTemp = createSandbox(libs, { network: false })!;
      const inLibs = (command: string) => runCommand(command, libs, 20, undefined, inTemp);
      const fsmonitor = `printf '[core]\\n\\tfsmonitor = touch planted\\n' >> ../.git/config`;
      assert.match(await inLibs(fsmonitor), denied);
      // Nor can its git directory be moved aside, to put another in its place.
      assert.match(await inLibs("mv ../.git ../.git-moved"), /Exit code: [1-9]/);
      assert.equal(await readFile(join(repo, ".git", "config"), "utf8"), config);
      // In a directory added with --add-dir, around a repository made in libs.
      const other = await repoWithSubmodule(added);
      const otherLibs = join(other, "libs");
      git(otherLibs, "init", "-q");
      const otherConfig = await readFile(join(other, ".git", "config"), "utf8");
      const inAdded = createSandbox(otherLibs, { network: false, dirs: [other] })!;
      assert.match(await runCommand(fsmonitor, otherLibs, 20, undefined, inAdded), denied);
      assert.match(await runCommand("mv ../.git ../.git-moved", otherLibs, 20, undefined, inAdded), /Exit code: [1-9]/);
      assert.equal(await readFile(join(other, ".git", "config"), "utf8"), otherConfig);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(added, { recursive: true, force: true });
    }
  });

  it("shows commands none of jig's own directory, though a repository around the project's leads there", async () => {
    // jig's directory is in the temp directory here, which commands can write, as an added one can hold it.
    const home = process.env.JIG_HOME!;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "secret"), "a session\n");
    git(home, "init", "-q", "--bare", "store.git");
    const project = join(dir, "project");
    await mkdir(project);
    git(project, "init", "-q");
    const look = async (command: string) => runCommand(command, project, 20, undefined, createSandbox(project, { network: false })!);
    // A .git above the project that leads to a git directory there, or to one holding jig's directory.
    await writeFile(join(dir, ".git"), `gitdir: ${join(home, "store.git")}\n`);
    assert.match(await look(`ls ${join(home, "store.git")}`), /No such file|Operation not permitted/);
    await writeFile(join(dir, ".git"), "gitdir: .\n");
    await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
    assert.match(await look(`cat ${join(home, "secret")}`), /No such file|Operation not permitted/);
  });

  it("still locks the config of a repository and of a submodule whose HEAD a command moved aside, and says so", async () => {
    const base = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      const repo = await repoWithSubmodule(base);
      const gitDir = join(await realpath(repo), ".git");
      const sub = join(gitDir, "modules", "libs", "s");
      const configs = () => Promise.all([gitDir, sub].map((dir) => readFile(join(dir, "config"), "utf8")));
      const before = await configs();
      // git passes over a git directory without a HEAD. Asked where the repository is, the next session would
      // lock nothing there, and a command could change the config and put the HEAD back.
      const first = createSandbox(repo, { network: false })!;
      const move = "mv .git/HEAD .git/HEAD.away && mv .git/modules/libs/s/HEAD .git/modules/libs/s/HEAD.away && echo moved";
      assert.equal(await runCommand(move, repo, 20, undefined, first), "moved\n\nExit code: 0");
      assert.deepEqual(first.gitChanges!(), [join(gitDir, "HEAD"), join(sub, "HEAD")]);
      assert.deepEqual(first.gitChanges!(), []);
      const next = createSandbox(repo, { network: false })!;
      for (const config of [".git/config", ".git/modules/libs/s/config"]) {
        assert.match(await runCommand(`printf '[core]\\n\\tfsmonitor = touch planted\\n' >> ${config}`, repo, 20, undefined, next), denied);
      }
      assert.deepEqual(await configs(), before);
      // Put back, both are in order again: nothing to say. A HEAD that names nothing, or refs gone, are told too.
      for (const dir of [gitDir, sub]) await rename(join(dir, "HEAD.away"), join(dir, "HEAD"));
      assert.deepEqual(next.gitChanges!(), []);
      await runCommand("echo nothing > .git/modules/libs/s/HEAD && mv .git/refs .git/refs-moved", repo, 20, undefined, next);
      assert.deepEqual(next.gitChanges!(), [join(gitDir, "refs"), join(sub, "HEAD")]);
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

  it("says when a command made a .git in the subdirectory of a repository it runs in", async () => {
    const repo = await mkdtemp(join(homedir(), ".jig-sandbox-repo-"));
    try {
      git(repo, "init", "-q");
      const sub = join(repo, "sub");
      await mkdir(sub);
      const sandbox = createSandbox(sub, { network: false })!;
      const inSub = (command: string) => runCommand(command, sub, 20, undefined, sandbox);
      // The user's git in the subdirectory would then use the config of the git directory it names. Making a
      // repository can be the task (git init), so neither sandbox refuses it, but the sandbox tells, once.
      assert.equal(await inSub(`echo "gitdir: ${tmpdir()}" > .git && echo planted`), "planted\n\nExit code: 0");
      const dotGit = join(await realpath(sub), ".git");
      assert.deepEqual(sandbox.gitChanges!(), [dotGit]);
      assert.deepEqual(sandbox.gitChanges!(), []);
      await inSub("rm .git && git init -q");
      assert.deepEqual(sandbox.gitChanges!(), [dotGit]);
      // Only the start of a file is read, so a long one that changes past it is told by its size.
      await inSub("rm -rf .git && printf '%070000d' 0 > .git");
      assert.deepEqual(sandbox.gitChanges!(), [dotGit]);
      await inSub("echo 1 >> .git");
      assert.deepEqual(sandbox.gitChanges!(), [dotGit]);
      // So is the subdirectory made a git directory, which git there takes for the repository.
      await inSub("rm .git && git init -q --bare .");
      assert.deepEqual(sandbox.gitChanges!(), [`${dirname(dotGit)}${sep}`]);
      assert.deepEqual(sandbox.gitChanges!(), []);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("says when a command made a .git, or a git directory, above the project, up to the repository", async () => {
    // In a temp directory, which commands can write.
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    try {
      git(repo, "init", "-q");
      const project = join(repo, "a", "b", "c");
      await mkdir(project, { recursive: true });
      const sandbox = createSandbox(project, { network: false })!;
      const a = join(await realpath(repo), "a");
      await runCommand("git init -q --bare ../..", project, 20, undefined, sandbox);
      assert.deepEqual(sandbox.gitChanges!(), [`${a}${sep}`]);
      await runCommand("git init -q ..", project, 20, undefined, sandbox);
      assert.deepEqual(sandbox.gitChanges!(), [join(a, "b", ".git")]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("says when a command made that .git a named pipe or a link to /dev/zero, without reading it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const sub = join(repo, "sub");
    await mkdir(sub);
    // Reading a named pipe waits for a writer, and /dev/zero never ends: either hung jig after the task.
    const commands: Record<string, string> = { "Make a pipe.": "mkfifo .git", "Make a link.": "rm .git && ln -s /dev/zero .git" };
    const api = await fakeMessagesApi((request) => {
      const task = (request.messages as { content: unknown }[]).at(-1)!.content;
      return typeof task === "string" ? [{ tool: "bash", input: { command: commands[task] } }] : [{ text: "Done." }];
    });
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5"], { api, cwd: sub, stdin: "Make a pipe.\nMake a link.\n", timeout: 20_000 });
      assert.equal(code, 0, output);
      const dotGit = join(await realpath(sub), ".git");
      assert.equal(output.split(`A command created or changed ${dotGit}, `).length - 1, 2, output);
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("starts in a repository where a command left named pipes or links to themselves in a worktree's or a submodule's git directory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    // None was there to be locked when that command ran, so neither sandbox stopped it.
    const gitDir = join(repo, ".git");
    for (const dir of ["worktrees/w", "modules/m", "modules/l"]) await mkdir(join(gitDir, dir), { recursive: true });
    for (const name of ["m", "l"]) await writeFile(join(gitDir, "modules", name, "HEAD"), "ref: refs/heads/main\n");
    execFileSync("mkfifo", [join(gitDir, "worktrees", "w", "gitdir"), join(gitDir, "modules", "m", "config")]);
    // Looking at a config that links to itself throws ELOOP, which stopped jig starting.
    await symlink("config", join(gitDir, "modules", "l", "config"));
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command: "echo ran" } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Tidy up."], { api, cwd: repo, timeout: 20_000 });
      assert.equal(code, 0, output);
      assert.match(JSON.stringify(api.requests[1].messages), /ran\\n/);
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns after a task in which a command made a commondir or a config.worktree", { skip: process.platform === "darwin" && "Seatbelt refuses to make them" }, async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const command = `echo ${tmpdir()} > .git/commondir && printf "[core]\\n" > .git/config.worktree`;
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Tidy up."], { api, cwd: repo });
      assert.equal(code, 0);
      const gitDir = join(await realpath(repo), ".git");
      assert.match(output, new RegExp(`A command created or changed ${join(gitDir, "commondir")}, .*: git would now read its config from elsewhere`));
      // A config.worktree doesn't send git elsewhere: it adds to the config.
      assert.match(output, new RegExp(`A command created or changed ${join(gitDir, "config.worktree")}, .*: git can read more config from it,`));
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns after a task in which a command moved a git directory's HEAD aside", async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const command = "mv .git/HEAD .git/HEAD.away";
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Tidy up."], { api, cwd: repo });
      assert.equal(code, 0, output);
      const gitDir = join(await realpath(repo), ".git");
      assert.match(output, new RegExp(`A command removed or broke ${join(gitDir, "HEAD")}, .*: git no longer takes ${gitDir} for a git directory, so it fails there or uses another above it`));
    } finally {
      api.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("warns after a task in which a command made the project, in a subdirectory of a repository, a git directory", async () => {
    const repo = await mkdtemp(join(tmpdir(), "jig-sandbox-repo-"));
    git(repo, "init", "-q");
    const sub = join(repo, "sub");
    await mkdir(sub);
    const command = "git init -q --bare .";
    const api = await fakeMessagesApi((request) => ((request.messages as unknown[]).length === 1 ? [{ tool: "bash", input: { command } }] : [{ text: "Done." }]));
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Make a repository."], { api, cwd: sub });
      assert.equal(code, 0, output);
      const made = await realpath(sub);
      assert.match(output, new RegExp(`A command made ${made} a git directory, which the sandbox doesn't prevent: git there would now take it for its repository`));
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
    const git = { locked: ["/p/.git/config", "/p/.git/hooks"], fixed: ["/p/.git"], gitDirectories: ["/p/.git"] };
    const profile = seatbeltProfile(["/p", "/private/tmp"], false, [], git);
    const locked = profile.indexOf('(deny file-write* (literal "/p/.git/config") (subpath "/p/.git/hooks"))');
    assert.ok(locked > profile.indexOf('(allow file-write* (subpath "/p")'), "after the rule it overrides, since the last rule wins");
    assert.match(profile, /^\(deny file-write-unlink \(literal "\/p\/\.git"\)\)$/m);
    assert.doesNotMatch(seatbeltProfile(["/p"], false, []), /\.git/);
  });

  it("hides jig's own directory but its skills, and leaves a project in it as it was", () => {
    // A skill being written in jig's directory, with a repository of its own and a file the user hides.
    const project = "/u/.jig/skills/s";
    const git = { locked: [`${project}/.git/config`], fixed: [`${project}/.git`], gitDirectories: [`${project}/.git`] };
    const lines = seatbeltProfile([project, "/private/tmp"], false, [`${project}/key`], git, "/u/.jig").split("\n");
    const at = (line: string) => {
      assert.ok(lines.includes(line), `${line} is in the profile`);
      return lines.indexOf(line);
    };
    // The last rule that matches wins.
    const order = [
      at('(deny file-read* file-write* (subpath "/u/.jig"))'),
      at('(allow file-read* (subpath "/u/.jig/skills"))'),
      at('(allow file-read* file-write* (subpath "/u/.jig/skills/s"))'),
      at('(deny file-write* (literal "/u/.jig/skills/s/.git/config"))'),
      at('(deny file-read* file-write* (subpath "/u/.jig/skills/s/key"))'),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(at('(allow file-read-metadata (literal "/u/.jig"))') > order[0], "paths through it can be resolved");
    assert.doesNotMatch(seatbeltProfile(["/p"], false, [], undefined, "/u/.jig"), /\(allow file-read\* file-write\*/);
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
      git(base, "init", "-q", "--bare", "server.git");
      assert.equal(gitControl(join(base, "server.git")), undefined, "in a bare repository");
      // A bare clone with its worktrees beside it is no server's: the user runs git in the worktrees. One
      // named .git is locked before it has any, as the file tools refuse its config.
      git(base, "clone", "-q", "--bare", repo, "x/.git");
      git(base, "clone", "-q", "--bare", repo, "y/.bare");
      await writeFile(join(base, "y", ".git"), "gitdir: ./.bare\n");
      const [x, y] = [await realpath(join(base, "x")), await realpath(join(base, "y"))];
      assert.ok(gitControl(x)?.locked.includes(join(x, ".git", "config")), "a bare x/.git");
      assert.equal(gitControl(y), undefined, "a bare y/.bare with no worktree");
      for (const folder of [x, y]) git(folder, "worktree", "add", "-q", "--detach", "main");
      for (const [project, config] of [[x, join(x, ".git", "config")], [y, join(y, ".bare", "config")]]) {
        for (const from of [project, join(project, "main")]) assert.ok(gitControl(from)?.locked.includes(config), `from ${from}`);
      }
      assert.ok(gitControl(y)?.locked.includes(join(y, ".git")), "y's .git file, which says where its git directory is");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("finds the repository's git directory with a git older than 2.31, which prints back a flag it doesn't know", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    const path = process.env.PATH;
    try {
      git(base, "init", "-q", "repo");
      await mkdir(join(base, "repo", "sub"));
      await mkdir(join(base, "bin"));
      // As git rev-parse before 2.31 (2.30 is Debian 11's) takes --path-format=absolute: it prints it back.
      const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const shim = `#!/bin/sh\nfor a do shift; case $a in --path-format=*) echo "$a" ;; *) set -- "$@" "$a" ;; esac; done\nexec '${real}' "$@"\n`;
      await writeFile(join(base, "bin", "git"), shim, { mode: 0o755 });
      process.env.PATH = `${join(base, "bin")}:${path}`;
      const config = join(await realpath(join(base, "repo")), ".git", "config");
      for (const project of ["repo", "repo/sub"]) assert.ok(gitControl(join(base, project))?.locked.includes(config), `from ${project}`);
    } finally {
      process.env.PATH = path;
      await rm(base, { recursive: true, force: true });
    }
  });

  it("takes a directory for a bare repository only as git does, and covers what the repository around one has in it", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    try {
      const repo = await repoWithSubmodule(base);
      await mkdir(join(repo, "docs"));
      const real = await realpath(repo);
      // A config a command wrote in a subdirectory, saying it is bare, git takes for no repository.
      for (const dir of ["docs", "libs"]) await writeFile(join(repo, dir, "config"), "[core]\n\tbare = true\n");
      // Nor with a HEAD and a commondir that names nothing: git looks for the objects and refs where it leads.
      await writeFile(join(repo, "docs", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(repo, "docs", "commondir"), "nowhere\n");
      assert.equal(git(join(repo, "docs"), "rev-parse", "--absolute-git-dir").trim(), join(real, ".git"));
      for (const dir of ["docs", "libs"]) assert.ok(gitControl(join(repo, dir))?.locked.includes(join(real, ".git", "config")), `from ${dir}`);
      // With a HEAD, objects and refs too, git does: it is left alone, as a server's would be, but the .git of
      // the checkout in it is denied, and nothing of repo's git directory, which isn't made writable, is fixed.
      git(join(repo, "libs"), "init", "-q", "--bare", ".");
      const control = gitControl(join(repo, "libs"))!;
      const profile = seatbeltProfile([join(real, "libs"), "/private/tmp"], false, [], control);
      const denied = profile.split("\n").find((line) => line.startsWith("(deny file-write* "))!;
      assert.equal(denied, `(deny file-write* (literal "${join(real, "libs", "s", ".git")}"))`);
      assert.doesNotMatch(profile, /file-write-unlink/);
      assert.deepEqual(control.fixed, []);
      // From a subdirectory of libs too, where the bare repository, writable as well, is above the project.
      await mkdir(join(repo, "libs", "deep"));
      assert.deepEqual(gitControl(join(repo, "libs", "deep"))?.locked, [join(real, "libs", "s", ".git")]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("covers what the repositories around a repository a command made have where commands can write", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    try {
      const repo = await repoWithSubmodule(base, "a/b/s");
      const real = await realpath(repo);
      const [b, dotGit] = [join(repo, "a", "b"), join(real, "a", "b", "s", ".git")];
      // A repository made in a/b, which holds the checkout a/b/s: its own files and repo's .git for the checkout.
      git(b, "init", "-q");
      for (const path of [join(real, "a", "b", ".git", "config"), dotGit]) assert.ok(gitControl(b)?.locked.includes(path), path);
      // One made in a as well, nearer than repo, leaves repo's covered all the same.
      git(join(repo, "a"), "init", "-q");
      assert.ok(gitControl(b)?.locked.includes(dotGit), "past a/.git");
      // Given the sandbox's writable directories, repo's files in any of them, and the directories holding them
      // there, which binding grants nothing; none of those outside one, which binding would make writable.
      const control = gitControl(b, undefined, [join(real, "a", "b"), real])!;
      assert.ok(control.locked.includes(join(real, ".git", "config")));
      assert.ok(control.fixed.includes(join(real, ".git", "modules", "a")));
      assert.deepEqual(control.fixed, [...control.fixed].sort((x, y) => x.length - y.length), "a directory before those in it");
      assert.ok(gitControl(b)!.fixed.every((dir) => dir.startsWith(join(real, "a", "b", ".git"))), "only a/b's own");
      const profile = seatbeltProfile([join(real, "a", "b"), real], false, [], control);
      const fixed = profile.split("\n").find((line) => line.startsWith("(deny file-write-unlink "))!;
      assert.ok(fixed.includes(`(literal "${join(real, ".git")}")`));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("finds every submodule's checkout, though git can't read one's config, and never waits on a pipe one includes", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    try {
      const repo = await repoWithSubmodule(base);
      git(repo, "submodule", "add", "-q", join(base, "sub"), "libs/t");
      const real = await realpath(repo);
      const [s, t] = ["s", "t"].map((name) => join(real, ".git", "modules", "libs", name, "config"));
      const dotGits = ["s", "t"].map((name) => join(real, "libs", name, ".git"));
      const config = await readFile(t, "utf8");
      await appendFile(t, "[core\n");
      assert.ok(gitControl(repo)?.locked.includes(dotGits[0]), "past the config git can't read");
      await writeFile(t, config);
      // git config --file follows no include a config makes, nor does jig: git would wait on a named pipe.
      const pipe = join(base, "pipe");
      execFileSync("mkfifo", [pipe]);
      await appendFile(s, `[include]\n\tpath = ${pipe}\n`);
      // Something writes to it, once, so that a git that opened it would go on, and leave a mark.
      const writer = spawn("sh", ["-c", `echo '[core]' > '${pipe}' && touch '${pipe}-opened'`]);
      try {
        const locked = gitControl(repo)?.locked;
        for (const path of dotGits) assert.ok(locked?.includes(path), path);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(existsSync(`${pipe}-opened`), false, "git opened the pipe");
      } finally {
        writer.kill();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("covers a git directory git passes over, and a submodule's that a planted HEAD would hide", async () => {
    const base = await mkdtemp(join(tmpdir(), "jig-profile-"));
    try {
      // In a repository of its own, where git goes on to once it passes over the project's.
      git(base, "init", "-q");
      const repo = await repoWithSubmodule(base);
      git(repo, "worktree", "add", "-q", "--detach", join(base, "wt"));
      const dotGit = join(await realpath(repo), ".git");
      const profileOf = (project: string) => seatbeltProfile([project], false, [], gitControl(project)!);
      const denied = (project: string) => profileOf(project).split("\n").find((line) => line.startsWith("(deny file-write* "))!;
      const configs = ["config", "modules/libs/s/config"].map((path) => `(literal "${join(dotGit, path)}")`);
      // A command moves HEAD aside in one session, or the refs: git takes base's repository for the project's.
      await rename(join(dotGit, "HEAD"), join(dotGit, "HEAD-moved"));
      await rename(join(dotGit, "modules", "libs", "s", "refs"), join(dotGit, "modules", "libs", "s", "refs-moved"));
      assert.equal(git(repo, "rev-parse", "--absolute-git-dir").trim(), join(await realpath(base), ".git"));
      // Nor does a config beside the .git that says it is bare, as a command can write one.
      await writeFile(join(repo, "config"), "[core]\n\tbare = true\n");
      for (const config of configs) assert.ok(denied(repo).includes(config), `${config} is read-only`);
      // From a linked worktree whose own HEAD is gone, which git takes for no repository at all.
      await rename(join(dotGit, "worktrees", "wt", "HEAD"), join(dotGit, "worktrees", "wt", "HEAD-moved"));
      assert.ok(denied(join(base, "wt")).includes(configs[0]), "from the worktree");
      // A HEAD or a config in modules/libs, as if it were a submodule's git directory, doesn't hide libs/s in it.
      await writeFile(join(dotGit, "modules", "libs", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(dotGit, "modules", "libs", "config"), "");
      assert.ok(denied(repo).includes(configs[1]), "behind a planted HEAD");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

/** git with an identity, and allowed to clone a submodule from a local path. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository in `base`/repo with one commit and a submodule at libs/s, or at `path`. */
async function repoWithSubmodule(base: string, path = "libs/s"): Promise<string> {
  const [repo, sub] = [join(base, "repo"), join(base, "sub")];
  for (const dir of [repo, sub]) {
    await mkdir(dir);
    git(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "1\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "first");
  }
  git(repo, "submodule", "add", "-q", sub, path);
  git(repo, "commit", "-qm", "submodule");
  return repo;
}

describe("snapshots", () => {
  /** git on the snapshots of the project in dir. */
  const snapshotGit = (...args: string[]) => git(dir, `--git-dir=${join(process.env.JIG_HOME!, "snapshots", projectKey(dir))}`, `--work-tree=${dir}`, ...args);

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

  it("leaves out the hidden paths in the project, which undo neither puts back nor removes", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(dir, ".env"), "e1");
    await mkdir(join(dir, "secrets"));
    await writeFile(join(dir, "secrets", "key"), "k1");
    // An older jig's snapshot holds them, and the index still has them.
    new Snapshots(dir).take("older jig");
    // By real path, as the sandbox hides them: here one is named through a link to the project.
    const link = `${dir}-link`;
    await symlink(dir, link);
    try {
      const snapshots = new Snapshots(dir, [join(link, ".env"), join(dir, "secrets"), join(dir, "not-there")]);
      snapshots.take("t");
      assert.equal(snapshotGit("ls-tree", "-r", "--name-only", "HEAD"), "a.txt\n");
      await writeFile(join(dir, "a.txt"), "2");
      await writeFile(join(dir, ".env"), "e2");
      await writeFile(join(dir, "secrets", "new"), "n");
      await writeFile(join(dir, "not-there"), "made by the task");
      assert.deepEqual(snapshots.changed(), ["a.txt"]);
      assert.deepEqual(snapshots.undo(), { changed: ["a.txt"], removed: [] });
      assert.equal(await readFile(join(dir, ".env"), "utf8"), "e2");
      assert.equal(await readFile(join(dir, "secrets", "new"), "utf8"), "n");
      assert.equal(await readFile(join(dir, "not-there"), "utf8"), "made by the task");
      assert.throws(() => new Snapshots(join(dir, "secrets"), [link]).take("t"), /hiddenPaths hide the project/);
    } finally {
      await rm(link);
    }
  });

  it("refuses projects too big to copy", async () => {
    await writeFile(join(dir, "data.bin"), Buffer.alloc(201_000_000));
    assert.throws(() => new Snapshots(dir).take("t"), /201 MB of files that aren't ignored/);
  });

  it("stops a git that waits on a named pipe a command made, and leaves no lock behind", async () => {
    // git opens a .gitignore or a .gitattributes and waits for as long as a named pipe is there: jig waited
    // with it, in its own thread, past --time-limit, before the next task or for a Stop hook's changed_files.
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "a.txt"), "1");
    const snapshots = new Snapshots(dir, [], undefined, 1);
    snapshots.take("t1");
    execFileSync("mkfifo", [join(dir, "sub", ".gitignore")]);
    assert.throws(() => snapshots.changed(), /git took over 1 seconds/);
    assert.throws(() => snapshots.take("t2"), /git took over 1 seconds/);
    await rm(join(dir, "sub", ".gitignore"));
    // git add waits on a .gitattributes holding the index's lock: stopped with SIGTERM, git removes the lock,
    // where SIGKILL left one that failed every later snapshot. It reads attributes only for a file it hashes,
    // so one changes size here: git hashes an unchanged file only if it was written in the same second as
    // t1's index, which made this test pass or fail by the clock.
    await writeFile(join(dir, "sub", "a.txt"), "12");
    execFileSync("mkfifo", [join(dir, ".gitattributes")]);
    assert.throws(() => snapshots.take("t3"), /git took over 1 seconds/);
    await rm(join(dir, ".gitattributes"));
    await writeFile(join(dir, "sub", "a.txt"), "2");
    snapshots.take("t4");
    assert.deepEqual(snapshots.undo(), { changed: [], removed: [] });
    assert.deepEqual(snapshots.undo(), { changed: ["sub/a.txt"], removed: [] });
    assert.equal(await readFile(join(dir, "sub", "a.txt"), "utf8"), "1");
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
    const snapshots = new Snapshots(dir, [], 1_000_000);
    snapshots.take("t1");
    await writeFile(join(dir, "b.bin"), Buffer.alloc(800_000)); // a dataset the task downloaded, say
    assert.throws(() => snapshots.take("t2"), /2 MB of files that aren't ignored, more than the 1 MB/);
    assert.equal(snapshots.undo(), undefined, "undoing to t1 would undo the next task too");
  });

  it("undo stores nothing the task created, so a big file can't get past the size check", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir, [], 1_000_000);
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

  it("leaves nested repositories out, and never runs a program their git config names", async () => {
    // A repository in the project, such as a sandboxed command can make, with a clean filter: git runs it
    // outside the sandbox to see whether an edited file in it changed, if it looks there at all.
    const nested = join(dir, "vendor", "x");
    await mkdir(nested, { recursive: true });
    await writeFile(join(dir, "a.txt"), "1");
    await writeFile(join(nested, "f.txt"), "1");
    git(nested, "init", "-q");
    git(nested, "add", "f.txt");
    git(nested, "commit", "-qm", "first");
    // Older versions of jig stored it in their snapshots, as a gitlink, and the index still has it.
    new Snapshots(dir).take("older jig");
    snapshotGit("add", "--all", ".");
    const ran = join(dir, "filter-ran");
    git(nested, "config", "filter.x.clean", `touch ${ran}; cat`);
    await writeFile(join(nested, ".git", "info", "attributes"), "* filter=x\n");
    await writeFile(join(nested, "f.txt"), "2"); // the same size, so git would have to read it

    const snapshots = new Snapshots(dir);
    snapshots.take("t");
    assert.equal(existsSync(ran), false, "git ran the nested repository's filter");
    assert.doesNotMatch(snapshotGit("ls-files", "--stage"), /^160000/m, "the snapshot holds no gitlink");
    await writeFile(join(dir, "a.txt"), "2");
    snapshotGit("add", "vendor/x"); // as git add stores one a command makes while a snapshot is taken
    assert.deepEqual(snapshots.changed(), ["a.txt"]);
    assert.deepEqual(snapshots.undo(), { changed: ["a.txt"], removed: [] });
    assert.equal(await readFile(join(nested, "f.txt"), "utf8"), "2", "files in a nested repository are left alone");
    assert.equal(existsSync(ran), false, "git ran the nested repository's filter");
  });

  it("keeps names that aren't UTF-8 as git wrote them, so such a repository is left out too", { skip: process.platform === "darwin" && "macOS takes only UTF-8 names" }, async () => {
    // A command picks the names. Decoded as UTF-8, 0xff turns into U+FFFD and no longer names the file: git
    // would store the repository and then run its filter, and /undo would leave such a file behind.
    const named = (prefix: string) => Buffer.concat([Buffer.from(join(dir, prefix)), Buffer.from([0xff])]);
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir);
    snapshots.take("t1");
    const nested = join(dir, "vendor");
    await mkdir(nested);
    await writeFile(join(nested, "f.txt"), "1");
    git(nested, "init", "-q");
    git(nested, "add", "f.txt");
    git(nested, "commit", "-qm", "first");
    const ran = join(dir, "filter-ran");
    git(nested, "config", "filter.x.clean", `touch ${ran}; cat`);
    await writeFile(join(nested, ".git", "info", "attributes"), "* filter=x\n");
    await writeFile(join(nested, "f.txt"), "2");
    await rename(nested, named("vendor-"));
    await writeFile(named("new-"), "n");
    snapshotGit("add", "--all", "."); // as git add stores one a command makes while a snapshot is taken

    assert.deepEqual(snapshots.changed(), ["new-�"]);
    snapshots.take("t2");
    assert.doesNotMatch(snapshotGit("ls-files", "--stage"), /^160000/m, "the snapshot holds no gitlink");
    await writeFile(join(dir, "a.txt"), "2");
    assert.deepEqual(snapshots.undo(), { changed: ["a.txt"], removed: [] });
    assert.deepEqual(snapshots.undo(), { changed: [], removed: ["new-�"] });
    assert.equal(existsSync(named("new-")), false);
    assert.equal(existsSync(ran), false, "git ran the nested repository's filter");
  });

  it("doesn't say it put back a file in a submodule, which it leaves alone", async () => {
    const repo = await repoWithSubmodule(dir);
    const snapshots = new Snapshots(repo);
    snapshots.take("t");
    await writeFile(join(repo, "libs", "s", "a.txt"), "2\n");
    assert.deepEqual(snapshots.changed(), []);
    assert.deepEqual(snapshots.undo(), { changed: [], removed: [] });
    assert.equal(await readFile(join(repo, "libs", "s", "a.txt"), "utf8"), "2\n");
  });

  it("undo removes what a task created around a repository it made, and leaves the repository", async () => {
    await writeFile(join(dir, "a.txt"), "1");
    const snapshots = new Snapshots(dir);
    snapshots.take("t");
    const clone = join(dir, "b", "clone");
    await mkdir(clone, { recursive: true });
    git(clone, "init", "-q"); // with no commit yet, which git can't store as a gitlink
    await writeFile(join(clone, "f.txt"), "f");
    await writeFile(join(dir, "a-new.txt"), "n"); // listed before the repository
    await writeFile(join(dir, "b", "z.txt"), "z"); // and after it
    assert.deepEqual(snapshots.undo(), { changed: [], removed: ["a-new.txt", "b/z.txt"] });
    assert.equal(existsSync(join(dir, "a-new.txt")), false);
    assert.equal(existsSync(join(clone, "f.txt")), true);
    snapshots.take("the next task");
  });

  it("sizes a symlink as git stores it, not what it points to", async () => {
    const project = join(dir, "project");
    await mkdir(join(project, "data"), { recursive: true });
    await writeFile(join(project, "data", "a.txt"), "1");
    await writeFile(join(dir, "big.bin"), Buffer.alloc(3_000_000)); // outside the project
    const snapshots = new Snapshots(project, [], 1_000_000);
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

  it("refuses a project's settings file that isn't a regular file, rather than waiting on it", async () => {
    // A command can leave a named pipe there, which jig would wait on for good, its deny rules unread.
    await mkdir(join(dir, ".jig"));
    execFileSync("mkfifo", [join(dir, ".jig", "settings.json")]);
    const api = await fakeMessagesApi(() => [{ text: "Done." }]);
    try {
      const { code, output } = await runJig(["--model", "claude-haiku-4-5", "Tidy up."], { api, cwd: dir, timeout: 20_000 });
      assert.equal(code, 1, output);
      assert.match(output, /\.jig\/settings\.json isn't a regular file \(a named pipe, say\), so jig doesn't read it/);
      assert.equal(api.requests.length, 0);
    } finally {
      api.close();
    }
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
