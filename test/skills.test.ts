import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { evalFileTargets, testSkill } from "../src/skill-evals.ts";
import { proposeSkillTool, type SkillProposal } from "../src/skill-proposals.ts";
import { compareSkills, describeSkill, fetchSource, findSkills, installedSkills, installSkill, lockedSource, parseSource, readLock, removeSkill } from "../src/skill-store.ts";
import { BUILTIN_SKILLS, discoverSkills, frontmatter, skillProblems } from "../src/skills.ts";
import { FileVersions } from "../src/tools/util.ts";
import { collectNotices } from "./notices.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jig-skills-"));
  process.env.JIG_HOME = join(dir, "jig-home");
});

async function writeSkill(base: string, name: string, description = `Does ${name}. Use when asked to ${name}.`, files: Record<string, string> = {}): Promise<string> {
  const skillDir = join(base, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(skillDir, path, ".."), { recursive: true });
    await writeFile(join(skillDir, path), content);
  }
  return skillDir;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** A git repository holding two skills under skills/, and something that isn't one. */
async function skillRepository(): Promise<string> {
  const repo = join(dir, "repo");
  await writeSkill(join(repo, "skills"), "alpha", undefined, { "scripts/run.sh": "echo alpha", "LICENSE.txt": "MIT" });
  await writeSkill(join(repo, "skills"), "beta");
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "docs", "README.md"), "not a skill");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "skills");
  return repo;
}

describe("skill sources", () => {
  it("reads folders, GitHub shorthand, GitHub pages and git URLs", () => {
    assert.deepEqual(parseSource("./here", { cwd: "/work" }), { spec: "./here", path: "/work/here" });
    assert.deepEqual(parseSource("anthropics/skills/skills/pdf@v2"), {
      spec: "anthropics/skills/skills/pdf@v2",
      url: "https://github.com/anthropics/skills.git",
      path: "skills/pdf",
      ref: "v2",
    });
    assert.deepEqual(parseSource("anthropics/skills"), { spec: "anthropics/skills", url: "https://github.com/anthropics/skills.git", path: "" });
    assert.deepEqual(parseSource("https://github.com/anthropics/skills/tree/main/skills/pdf"), {
      spec: "https://github.com/anthropics/skills/tree/main/skills/pdf",
      url: "https://github.com/anthropics/skills.git",
      path: "skills/pdf",
      ref: "main",
    });
    assert.deepEqual(parseSource("git@example.com:team/skills.git", { path: "release" }), { spec: "git@example.com:team/skills.git", url: "git@example.com:team/skills.git", path: "release" });
    assert.throws(() => parseSource("just-a-word"), /Can't tell where/);
  });
});

describe("installing skills", () => {
  it("clones a repository's skills sparsely, installs them, and records where they came from", async () => {
    const repo = await skillRepository();
    const source = parseSource(`file://${repo}`, { path: "skills" });
    const fetched = fetchSource(source);
    try {
      const found = findSkills(fetched.dir).map(describeSkill);
      assert.deepEqual(found.map((info) => info.name), ["alpha", "beta"]);
      assert.deepEqual(found[0].scripts, ["scripts/run.sh"]);
      assert.equal(found[0].license, "see LICENSE.txt");
      assert.ok(!existsSync(join(fetched.root, "docs")), "a sparse clone leaves out what wasn't asked for");
      const target = installSkill(found[0], source, fetched, { scope: "project", project: dir });
      assert.equal(target, join(dir, ".jig", "skills", "alpha"));
      assert.equal(await readFile(join(target, "scripts", "run.sh"), "utf8"), "echo alpha");
      assert.throws(() => installSkill(found[0], source, fetched, { scope: "project", project: dir }), /already a skill "alpha".*--force/);
    } finally {
      fetched.cleanup();
    }
    const entry = readLock("project", dir).alpha;
    assert.equal(entry.url, `file://${repo}`);
    assert.equal(entry.path, "skills/alpha");
    assert.equal(entry.commit, git(repo, "rev-parse", "HEAD"));
    assert.deepEqual(discoverSkills(dir, join(dir, "home"), { builtin: null }).skills.map((skill) => [skill.name, skill.scope]), [["alpha", "project"]]);
  });

  it("sees what changed upstream, updates, and removes", async () => {
    const repo = await skillRepository();
    const source = parseSource(`file://${repo}`, { path: "skills/beta" });
    const first = fetchSource(source);
    installSkill(describeSkill(first.dir), source, first, { scope: "user", project: dir });
    first.cleanup();
    await writeFile(join(repo, "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: Does beta better. Use when asked to beta.\n---\n\nNew steps.\n");
    await writeFile(join(repo, "skills", "beta", "notes.md"), "more");
    git(repo, "commit", "-qam", "better beta");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "notes");

    const [installed] = installedSkills(dir);
    assert.equal(installed.scope, "user");
    const again = fetchSource(lockedSource(installed.entry));
    try {
      assert.deepEqual(compareSkills(installed.dir, again.dir), { added: ["notes.md"], removed: [], changed: ["SKILL.md"] });
      installSkill(describeSkill(again.dir), lockedSource(installed.entry), again, { scope: "user", project: dir, force: true });
    } finally {
      again.cleanup();
    }
    assert.equal(readLock("user", dir).beta.commit, git(repo, "rev-parse", "HEAD"));
    assert.match(await readFile(join(installed.dir, "SKILL.md"), "utf8"), /New steps/);
    removeSkill(installedSkills(dir)[0], dir);
    assert.ok(!existsSync(installed.dir));
    assert.deepEqual(readLock("user", dir), {});
  });

  it("checks skills against the Agent Skills specification", async () => {
    assert.deepEqual(skillProblems(await writeSkill(dir, "fine")), []);
    assert.match(skillProblems(await writeSkill(dir, "Bad-Name")).join(" "), /lowercase letters/);
    const misplaced = join(dir, "elsewhere");
    await mkdir(misplaced);
    await writeFile(join(misplaced, "SKILL.md"), "---\nname: other\ndescription: x\n---\n");
    assert.match(skillProblems(misplaced).join(" "), /doesn't match its directory/);
    assert.match(skillProblems(await writeSkill(dir, "wordy", "x".repeat(1025))).join(" "), /longer than 1024/);
    assert.throws(() => fetchSource(parseSource(join(dir, "missing"))), /isn't a folder/);
  });
});

describe("finding skills", () => {
  it("adds jig's own skills last, takes the user's from JIG_HOME, and hides what --hide-skill names", async () => {
    await writeSkill(join(process.env.JIG_HOME!, "skills"), "mine");
    await writeSkill(join(dir, ".jig", "skills"), "skill-writer", "A project's own version. Use when writing skills here.");
    const names = (hidden: string[] = []) => discoverSkills(dir, join(dir, "home"), { hidden }).skills.map((skill) => `${skill.scope}:${skill.name}`);
    assert.deepEqual(names(), ["project:skill-writer", "user:mine"], "the project's skill-writer hides jig's");
    assert.deepEqual(names(["skill-writer", "mine"]), []);
    assert.ok(existsSync(join(BUILTIN_SKILLS, "skill-writer", "SKILL.md")));
    assert.deepEqual(skillProblems(join(BUILTIN_SKILLS, "skill-writer")), [], "jig's own skill follows the specification");
  });
});

describe("proposing a skill", () => {
  const proposal: SkillProposal = {
    name: "release-notes",
    description: 'Writes release notes from the git log, in "Keep a Changelog" style: added, fixed. Use when asked for release notes.',
    instructions: "1. Run scripts/collect.sh.\n2. Group the lines.",
    files: { "scripts/collect.sh": "git log --oneline" },
    evals: [{ prompt: "Write notes for v1.2", expected_output: "A CHANGELOG entry", expectations: ["CHANGELOG.md has a v1.2 section"], check: "grep -q v1.2 CHANGELOG.md" }],
  };
  const context = () => ({ cwd: dir, versions: new FileVersions() });

  it("is checked against the specification before anyone is asked", async () => {
    let asked = false;
    const tool = proposeSkillTool(async () => ((asked = true), "project"));
    await assert.rejects(tool.run({ ...proposal, name: "Release Notes" }, context()), /lowercase letters/);
    await assert.rejects(tool.run({ ...proposal, files: { "../escape.sh": "x" } }, context()), /isn't inside the skill's folder/);
    await assert.rejects(tool.run({ ...proposal, files: { "SKILL.md": "x" } }, context()), /written from the other fields/);
    assert.equal(asked, false);
  });

  it("is saved only where the user says, as a valid skill with its evals", async () => {
    const shown: string[][] = [];
    const answers = ["project", "proposal", null] as const;
    const tool = proposeSkillTool(async (_proposal, files) => (shown.push([...files.keys()]), answers[shown.length - 1]));

    assert.match(await tool.run({ ...proposal }, context()), /Saved the skill "release-notes" in .*\.jig\/skills\/release-notes/);
    const saved = join(dir, ".jig", "skills", "release-notes");
    assert.deepEqual(shown[0], ["SKILL.md", "scripts/collect.sh", "evals/evals.json"]);
    assert.deepEqual(skillProblems(saved), []);
    assert.equal(frontmatter(await readFile(join(saved, "SKILL.md"), "utf8")).description, proposal.description, "the quoted description reads back exactly");
    assert.ok((statSync(join(saved, "scripts", "collect.sh")).mode & 0o100) !== 0, "scripts are executable");
    const evals = JSON.parse(await readFile(join(saved, "evals", "evals.json"), "utf8"));
    assert.deepEqual(evals.evals[0], { id: 1, ...proposal.evals![0] });
    assert.equal(evals.skill_name, "release-notes");

    assert.match(await tool.run({ ...proposal }, context()), /saved as a proposal in .*\.jig\/proposals\/skills\/release-notes.*jig skills add/s);
    assert.match(await tool.run({ ...proposal }, context()), /didn't keep this skill/);
  });

  it("isn't saved, nor an earlier version removed, through a symlink out of the project", async () => {
    // jig writes the skill itself, outside the sandbox, so a .jig a sandboxed command made into a symlink
    // would otherwise let it delete and write folders of the user's.
    const outside = await mkdtemp(join(tmpdir(), "jig-skills-outside-"));
    await mkdir(join(outside, "skills", "release-notes"), { recursive: true });
    await writeFile(join(outside, "skills", "release-notes", "work.txt"), "the user's own\n");
    await symlink(outside, join(dir, ".jig"));
    for (const decision of ["project", "proposal"] as const) {
      await assert.rejects(proposeSkillTool(async () => decision).run({ ...proposal }, context()), /\.jig\/.*release-notes leads through a symlink to .*, outside the working directory/);
    }
    assert.equal(await readFile(join(outside, "skills", "release-notes", "work.txt"), "utf8"), "the user's own\n");
    assert.ok(!existsSync(join(outside, "proposals")));
  });
});

describe("testing a skill", () => {
  /** A fake Messages API whose model writes greeting.txt only when the greeting skill is in its prompt. */
  async function fakeApi(): Promise<{ url: string; close: () => void }> {
    const event = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const reply = (blocks: ({ text: string } | { tool: string; input: object })[]) => {
      let body = event("message_start", { message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      blocks.forEach((block, index) => {
        if ("text" in block) {
          body += event("content_block_start", { index, content_block: { type: "text", text: "" } });
          body += event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
        } else {
          body += event("content_block_start", { index, content_block: { type: "tool_use", id: `call_${index}_${block.tool}`, name: block.tool, input: {} } });
          body += event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        }
        body += event("content_block_stop", { index });
      });
      const stop = blocks.some((block) => "tool" in block) ? "tool_use" : "end_turn";
      return body + event("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }) + event("message_stop", {});
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const request = JSON.parse(body);
        const system = typeof request.system === "string" ? request.system : request.system.map((block: { text: string }) => block.text).join("");
        const knowsSkill = system.includes('<skill name="greeting">');
        const last = JSON.stringify(request.messages.at(-1));
        res.writeHead(200, { "content-type": "text/event-stream" });
        // With the skill, it writes the greeting and commits it, as a release task would.
        const greet = "printf 'hello from the skill\\n' > greeting.txt && git add -A && git -c user.name=t -c user.email=t@t commit -qm 'Greet the team'";
        if (!knowsSkill || last.includes("call_0_bash")) res.end(reply([{ text: "Done." }]));
        else if (last.includes("call_0_skill")) res.end(reply([{ tool: "bash", input: { command: greet } }]));
        else res.end(reply([{ tool: "skill", input: { name: "greeting" } }]));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => (server.closeAllConnections(), server.close()) };
  }

  it("puts an eval's files in the project with their layout below the folder they share", () => {
    const folder = (file: string) => !file.includes(".");
    assert.deepEqual(evalFileTargets(["evals/files/basic/VERSION.txt", "evals/files/basic/src/acme/app.py"], folder), [
      ["evals/files/basic/VERSION.txt", "VERSION.txt"],
      ["evals/files/basic/src/acme/app.py", "src/acme/app.py"],
    ]);
    assert.deepEqual(evalFileTargets(["evals/files/basic/src/acme/app.py", "evals/files/basic/VERSION.txt"], folder), [
      ["evals/files/basic/src/acme/app.py", "src/acme/app.py"],
      ["evals/files/basic/VERSION.txt", "VERSION.txt"],
    ]);
    assert.deepEqual(evalFileTargets(["evals/files/sample.csv"], folder), [["evals/files/sample.csv", "sample.csv"]]);
    assert.deepEqual(evalFileTargets(["evals/files/basic"], folder), [["evals/files/basic", "."]]);
    assert.deepEqual(evalFileTargets([], folder), []);
  });

  it("runs each eval with and without the skill, and grades it by its check", async () => {
    await writeSkill(join(dir, ".jig", "skills"), "greeting", "Writes the team greeting. Use when asked to greet.", {
      "evals/evals.json": JSON.stringify({
        skill_name: "greeting",
        evals: [{ id: 1, prompt: "Greet the team.", check: "grep -q 'hello from the skill' greeting.txt", expectations: ["greeting.txt holds the greeting"] }],
      }),
    });
    const api = await fakeApi();
    const { stop } = collectNotices("never printed");
    const evidence: string[] = [];
    try {
      const runs = await testSkill(dir, "greeting", {
        grade: async (evalCase, changes) => {
          evidence.push(changes);
          return evalCase.expectations!.map((text) => ({ text, passed: changes.includes("+hello from the skill"), evidence: "" }));
        },
        attempts: 1,
        model: "claude-haiku-4-5",
        cli: join(import.meta.dirname, "..", "src", "cli.ts"),
        env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: "test-key" },
        timeout: 60,
      });
      const byArm = Object.fromEntries(runs.map((run) => [run.arm, run]));
      assert.equal(byArm.with.passed, true);
      assert.equal(byArm.with.loaded, true);
      assert.equal(byArm.with.check, true);
      assert.equal(byArm.without.passed, false);
      assert.equal(byArm.without.loaded, false);
      assert.equal(byArm.with.steps, 3);
      assert.match(evidence[0], /Commits made:\n\w+ Greet the team/, "the grader sees what the agent committed");
      assert.match(evidence[0], /\+hello from the skill/);
      assert.deepEqual(byArm.with.grades?.map((g) => g.passed), [true]);
      assert.deepEqual(byArm.without.grades?.map((g) => g.passed), [false]);
    } finally {
      stop();
      api.close();
    }
  });
});
