import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { removeTempDirs, tempDir } from "./temp-dirs.ts";

// eval/: the Terminal-Bench report (report.py) and jig's Harbor adapter (jig_agent.py), run with python3.

const ROOT = join(import.meta.dirname, "..");

afterEach(removeTempDirs);

interface Fixture {
  task: string;
  reward: number;
  /** The verifier's output, if it started; with `ctrf`, it got as far as running the tests. */
  stdout?: string;
  ctrf?: boolean;
  /** The exception Harbor recorded for the trial, if any. */
  exception?: string;
}

/** A Harbor job directory as Terminal-Bench's trials leave it: config.json, and a result.json and verifier/ per trial. */
async function job(dir: string, trials: Fixture[]): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.json"), JSON.stringify({ agents: [{ name: "jig", kwargs: {} }] }));
  for (const [i, trial] of trials.entries()) {
    const path = join(dir, `${trial.task}__${i}`);
    await mkdir(join(path, "agent"), { recursive: true });
    const started = trial.stdout !== undefined || trial.ctrf;
    const result = {
      task_name: trial.task,
      verifier: started ? { started_at: "2026-10-31T20:48:25.541352Z", finished_at: "2026-10-31T20:49:28.857578Z" } : null,
      verifier_result: started ? { rewards: { reward: trial.reward } } : null,
      exception_info: trial.exception ? { exception_type: trial.exception } : null,
      agent_result: {},
      agent_info: { model_info: { name: "deepseek-flash" } },
    };
    await writeFile(join(path, "result.json"), JSON.stringify(result));
    if (!started) continue;
    await mkdir(join(path, "verifier"));
    await writeFile(join(path, "verifier", "test-stdout.txt"), trial.stdout ?? "");
    if (trial.ctrf) await writeFile(join(path, "verifier", "ctrf.json"), '{"results": {}}');
  }
  return dir;
}

function report(...args: string[]): string {
  return execFileSync("python3", ["-B", "eval/report.py", ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("the Terminal-Bench report", () => {
  // Milestone 30's runs, in small: a verifier out of disk (pytorch-model-recovery), and one whose download of its
  // tests was refused on this machine (filter-js-from-html, 403), each scored a failure. And failures that are
  // the agent's, though the verifier wrote no result: jig's install failed, so Harbor never ran the tests; the
  // tests ran out of time on the work (filter-js-from-html's, four times before milestone 30); and the agent
  // left dpkg locked and curl removed, so the tests couldn't start, with or without running out of time itself.
  // And a verifier that graded the work though its output has the disk's message, from a test's captured output.
  const OUT_OF_DISK = "  × Failed to download `triton==3.3.1`\n      No space left on device (os error 28)\n";
  const BROKEN = "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1234 (apt-get)\n/tests/test.sh: line 9: curl: command not found\n";
  const CAPTURED = "----------------------------- Captured stdout call -----------------------------\nOSError: [Errno 28] No space left on device\n";
  const REFUSED = ">       raise HTTPError(req.full_url, code, msg, hdrs, fp)\nE       urllib.error.HTTPError: HTTP Error 403: Forbidden\n";

  async function runs(dir: string): Promise<{ off: string; on: string }> {
    const off = await job(join(dir, "off"), [
      { task: "a", reward: 1, ctrf: true },
      { task: "b", reward: 0, ctrf: true },
      { task: "disk", reward: 0, stdout: OUT_OF_DISK },
      { task: "broke", reward: 0, stdout: BROKEN },
      { task: "server", reward: 0, ctrf: true, stdout: REFUSED },
      { task: "corpus", reward: 0, ctrf: true, stdout: REFUSED },
      { task: "install", reward: 0, exception: "RuntimeError" },
      { task: "hangs", reward: 0, stdout: "tests/test_outputs.py ..", exception: "VerifierTimeoutError" },
      { task: "slow", reward: 0, stdout: BROKEN, exception: "AgentTimeoutError" },
      { task: "loud", reward: 1, ctrf: true, stdout: CAPTURED },
    ]);
    const on = await job(join(dir, "on"), [
      { task: "a", reward: 1, ctrf: true },
      { task: "b", reward: 1, ctrf: true },
      { task: "disk", reward: 1, ctrf: true },
      { task: "broke", reward: 1, ctrf: true },
      { task: "server", reward: 0, ctrf: true, stdout: REFUSED },
      { task: "corpus", reward: 0, ctrf: true, stdout: REFUSED },
      { task: "install", reward: 1, ctrf: true },
      { task: "hangs", reward: 1, ctrf: true },
      { task: "slow", reward: 1, ctrf: true },
      { task: "loud", reward: 0, ctrf: true, stdout: `${CAPTURED}FAILED tests/test_outputs.py::test_model\n` },
    ]);
    return { off, on };
  }

  it("leaves out the trials no agent could pass here, from the pass rates and the comparison", async () => {
    const dir = await tempDir("jig-eval-");
    const { off, on } = await runs(dir);
    await writeFile(join(dir, "skip.txt"), "# tasks whose verifier can't run here\ncorpus  # its download of its tests is refused here (403)\n");
    const out = report("--save", join(dir, "saved"), "--skip-tasks", join(dir, "skip.txt"), off, on);
    // An HTTP error in a test is the task's own server failing, as far as the report can tell: the agent's failure.
    assert.match(out, /\| off \| jig \| 2\/8 \(25%\) \| [^|]+ \| 2 \| 0 \| 1 \| 2 \|/);
    assert.match(out, /\| on \| jig \| 7\/9 \(78%\) \| [^|]+ \| 1 \|/);
    assert.match(out, /- on minus off: \+50 points \(95% CI [^)]+\), over 8 tasks/);
    assert.match(out, /\| disk \| \? \| ✓ \|/);
    assert.match(out, /\| corpus \| \? \| \? \|/);
    assert.match(out, /\| server \| ✗ \| ✗ \|/);
    assert.match(out, /\| install \| ! \| ✓ \|/);
    assert.match(out, /\| hangs \| ! \| ✓ \|/);
    // No result from tests the agent left no way to start is a failure, its own; a result is a grade, whatever was printed.
    assert.match(out, /\| broke \| ✗ \| ✓ \|/);
    assert.match(out, /\| slow \| ⏱ \| ✓ \|/);
    assert.match(out, /\| loud \| ✓ \| ✗ \|/);
    assert.match(out, /- corpus, skipped \(its download of its tests is refused here \(403\)\): 1 in off, 1 in on/);
    const saved = (name: string) => JSON.parse(readFileSync(join(dir, "saved", `${name}.json`), "utf8")).trials as { task: string; unscorable: string | null }[];
    assert.deepEqual(
      saved("off").map((trial) => [trial.task, trial.unscorable]),
      [
        ["a", null],
        ["b", null],
        ["broke", null],
        ["corpus", "skipped (its download of its tests is refused here (403))"],
        ["disk", "its verifier ran out of disk"],
        ["hangs", null],
        ["install", null],
        ["loud", null],
        ["server", null],
        ["slow", null],
      ],
    );
  });

  it("keeps what it left out in the summaries it saves, and skips tasks in them too", async () => {
    const dir = await tempDir("jig-eval-");
    const { off, on } = await runs(dir);
    report("--save", join(dir, "saved"), off, on);
    const again = report("--skip-task", "corpus", join(dir, "saved", "off.json"), join(dir, "saved", "on.json"));
    assert.match(again, /\| off \| jig \| 2\/8 \(25%\) \| [^|]+ \| 2 \|/);
    assert.match(again, /- on minus off: \+50 points \(95% CI [^)]+\), over 8 tasks/);
    assert.match(again, /- corpus, skipped \(--skip-task\): 1 in off, 1 in on/);
  });
});

describe("the Harbor adapter", () => {
  // jig_agent.py without Harbor, pydantic or Jinja installed: what it imports from them, as stand-ins.
  const STANDINS = `
import sys, types, typing
typing.override = getattr(typing, "override", lambda f: f)  # Pythons before 3.12 have none
def standin(name, **values):
    module = types.ModuleType(name)
    module.__dict__.update(values)
    sys.modules[name] = module
standin("jinja2")
standin("pydantic", Field=lambda default=None, **_: default)
standin("harbor.agents.installed.base", BaseInstalledAgent=object, with_prompt_template=lambda f: f)
standin("harbor.agents.installed.node_install", nvm_node_install_snippet=lambda major: "")
standin("harbor.agents.options", Cli=lambda *_, **__: None, InstalledAgentOptions=object)
standin("harbor.environments.base", BaseEnvironment=object)
standin("harbor.environments.docker.docker", DockerEnvironment=object, _sanitize_docker_compose_project_name=str)
standin("harbor.models.agent.context", AgentContext=object)
sys.path.insert(0, "eval")
import jig_agent
`;

  it("starts jig with nvm's node, and leaves nvm off the PATH of the model's commands", async () => {
    // The task's tests run with the image's own node (make-mips-interpreter's is Debian's), so the model's
    // commands should find that one, or none, as the tests will, and not the Node 24 jig needs.
    const home = await tempDir("jig-eval-home-");
    const bin = join(home, ".nvm", "versions", "node", "v24.22.2", "bin");
    await mkdir(bin, { recursive: true });
    // nvm.sh, sourced, puts its default version's bin directory first on the PATH, as the real one does.
    await writeFile(join(home, ".nvm", "nvm.sh"), 'export PATH="$NVM_DIR/versions/node/v24.22.2/bin:$PATH"\n');
    await writeFile(join(bin, "node"), '#!/bin/sh\necho "node: $0 $1"\necho "PATH: $PATH"\n', { mode: 0o755 });
    await writeFile(join(home, "task.txt"), "do the task\n");
    const script = `${STANDINS}\nprint(jig_agent.Jig._jig("deepseek-flash", "", sys.argv[1], "jig-stats.json"))`;
    const command = execFileSync("python3", ["-B", "-c", script, join(home, "task.txt")], { cwd: ROOT, encoding: "utf8" }).trim();
    // The transcript goes to the trial's logs, which are here instead. No stdin: on a socket, as Node's pipes
    // are, Debian's bash takes itself for a remote shell and reads the system's bashrc, which may change the PATH.
    const logs = join(home, "logs");
    await mkdir(logs);
    const env = { HOME: home, PATH: "/usr/bin:/bin" };
    const output = execFileSync("bash", ["-c", command.replaceAll("/logs/agent/", `${logs}/`)], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(output.trim().split("\n"), [`node: ${join(bin, "node")} /installed-agent/jig/src/cli.ts`, "PATH: /usr/bin:/bin"]);
  });
});
