"""Harbor adapter: runs jig inside each task's container, for Terminal-Bench and other Harbor datasets.

    export DEEPSEEK_API_KEY=...
    PYTHONPATH=eval eval/.venv/bin/harbor run -d terminal-bench@2.0 -a jig_agent:Jig -m deepseek/deepseek-flash

jig comes from this checkout: the working tree, or a git ref given with --ak ref=m5. The API key is read
from the environment harbor runs in and stays on the host: jig's process in the container gets a token of
this run instead, and its requests go through key_proxy.py, which puts the key in (milestone 25; with
--ak key_proxy=false jig gets the key itself, as before). Either way it is never written into the job's files.

jig is given the agent's time limit, less 30 seconds, as --time-limit, so that it stops itself before Harbor
stops waiting and runs the hidden tests: without it, jig worked on into them (milestone 6). A version of jig
from before --time-limit (--ak ref=...) runs without it.

With --ak run_reviewer=deepseek-flash (milestone 29), once jig is done, that model reviews the work by running
it: the task's container is committed to an image, a copy started from it with no network and no mounts, and
`jig review` run here on the host with its commands going into the copy. Each problem's command is run again
in a fresh copy (--ak recheck=false: not), and the problems it shows go back to jig, --continue, in the time
left. This needs Harbor's local Docker environment, where the adapter can reach the task's container.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shlex
import subprocess
import tarfile
import tempfile
import time
import tomllib
from pathlib import Path
from typing import Annotated, override

import jinja2
from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import DockerEnvironment, _sanitize_docker_compose_project_name
from harbor.models.agent.context import AgentContext
from key_proxy import UPSTREAMS, proxy_for

REPO = Path(__file__).resolve().parent.parent
MINI_PROMPTS = Path(__file__).resolve().parent / "mini-swe-agent-prompts.json"
INSTALL_DIR = "/installed-agent/jig"
TASK_FILE = "/installed-agent/task.txt"
REVIEW_FILE = "/installed-agent/review.txt"
# The review's time: 5 minutes, or a quarter of the agent's time limit if that is less. It starts only with
# at least twice that left, so that a fix after it has as long as the review had.
REVIEW_SECONDS = 300
# How long before the agent's time limit jig is told to stop (--time-limit): enough for what its clock doesn't
# count, Node starting say, and for it to stop and exit.
TIME_MARGIN = 30
# What docker diff lists that isn't the agent's work: jig's own install, and OrbStack's certificate.
NOT_THE_WORK = re.compile(r"^/(installed-agent|root/\.nvm|root/\.npm|logs)(/|$)|orbstack", re.I)
MAX_CHANGES = 150
# Of Docker's memory, what is left unused beside the containers and the copy, and the least a copy may have.
COPY_MARGIN = 256 * 2**20
MIN_COPY_MEMORY = 512 * 2**20
LOAD_NODE = 'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"'
# USD per million tokens: uncached input, cached input, output (the same table as bench/metrics.ts).
PRICES = {
    "deepseek-flash": (0.3, 0.006, 1.2),
    "deepseek-v4-pro": (1.32, 0.044, 3.96),
    "claude-opus-5-5": (4.0, 0.2, 20.0),
    "claude-sonnet-5-5": (2.0, 0.2, 10.0),
}


class JigOptions(InstalledAgentOptions):
    ref: str | None = Field(default=None, description="git ref of jig to run (default: the working tree)")
    effort: Annotated[str | None, Cli("--effort")] = Field(default=None, description="jig's --effort")
    max_steps: Annotated[int | None, Cli("--max-steps")] = Field(
        default=300, description="jig's --max-steps; the task's time limit is the real bound"
    )
    compact_at: Annotated[int | None, Cli("--compact-at")] = Field(
        default=None, description="jig's --compact-at (0: never compact)"
    )
    no_subagents: Annotated[bool | None, Cli("--no-subagents")] = Field(
        default=None, description="leave out the subagent tool"
    )
    check: Annotated[bool | None, Cli("--check")] = Field(
        default=None, description="ask the model to check its work before finishing"
    )
    no_budget_notes: Annotated[bool | None, Cli("--no-budget-notes")] = Field(
        default=None, description="jig's --no-budget-notes: don't tell the model what is left of its steps and time"
    )
    finish_gate: Annotated[bool | None, Cli("--finish-gate")] = Field(
        default=None, description="jig's --finish-gate: send the model back once if its trace shows unchecked work"
    )
    tools: Annotated[str | None, Cli("--tools")] = Field(
        default=None, description="jig's --tools: only these of its tools, e.g. bash"
    )
    prompts: str | None = Field(
        default=None, description="mini: mini-swe-agent's system prompt and task template instead of jig's"
    )
    api: Annotated[str | None, Cli("--api")] = Field(
        default=None, description="jig's --api: anthropic or openai (DeepSeek serves both)"
    )
    reviewer: Annotated[str | None, Cli("--reviewer")] = Field(
        default=None, description="jig's --reviewer: a model that checks the work against the task before it ends"
    )
    escalate: Annotated[str | None, Cli("--escalate")] = Field(
        default=None, description="jig's --escalate: a model that takes over once a test run fails"
    )
    run_reviewer: str | None = Field(
        default=None,
        description="milestone 29: once jig is done, this model reviews the work by running it, in a copy of the "
        "task's container with no network, and the problems it shows go back to jig (Harbor's local Docker only)",
    )
    recheck: bool = Field(
        default=True,
        description="with run_reviewer: run each problem's command again in a fresh copy, and send back only "
        "the problems it shows",
    )
    key_proxy: bool = Field(
        default=True,
        description="keep the API key on the host: the container gets a token of this run, and a proxy here "
        "(key_proxy.py) puts the key in. Off: the key goes into the container, as before milestone 25",
    )


class Jig(BaseInstalledAgent):
    options_model = JigOptions
    options: JigOptions

    @staticmethod
    @override
    def name() -> str:
        return "jig"

    @override
    def get_version_command(self) -> str | None:
        return f"cat {INSTALL_DIR}/VERSION"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Node from nvm (jig runs its TypeScript directly, so it needs Node 22.18 or newer), then jig's
        # source from this checkout and its npm dependencies. Outside node_modules, since Node won't
        # strip types from files under node_modules.
        await self.ensure_system_dependencies(environment, ("curl", "bash", "tar"))
        await self.exec_as_agent(
            environment,
            command=f"set -eo pipefail; {nvm_node_install_snippet(24)}",
            env={"NVM_NODEJS_ORG_MIRROR": "https://nodejs.org/dist"},
        )
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "jig.tar.gz"
            self._pack(archive)
            await environment.upload_file(archive, "/installed-agent/jig.tar.gz")
        owner = environment.default_user
        chown = f" && chown -R {shlex.quote(str(owner))} {INSTALL_DIR}" if owner is not None else ""
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {INSTALL_DIR} && tar -xzf /installed-agent/jig.tar.gz -C {INSTALL_DIR}{chown}",
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"set -eo pipefail; {LOAD_NODE} && cd {INSTALL_DIR} && "
                "npm ci --omit=dev --no-audit --no-fund --loglevel=error && node src/cli.ts --help > /dev/null"
            ),
        )

    def _pack(self, archive: Path) -> None:
        """package.json, package-lock.json and src/ of the chosen version, plus a VERSION file."""
        git = lambda *args: subprocess.run(  # noqa: E731
            ["git", *args], cwd=REPO, check=True, capture_output=True, text=True
        ).stdout.strip()
        files = ["package.json", "package-lock.json", "src"]
        if self.options.ref:
            version = f"{self.options.ref} ({git('rev-parse', '--short', self.options.ref)})"
            subprocess.run(
                ["git", "archive", "--format=tar.gz", "-o", str(archive), self.options.ref, *files],
                cwd=REPO,
                check=True,
            )
            with tarfile.open(archive, "r:gz") as source:
                members = [(member, source.extractfile(member)) for member in source.getmembers()]
                contents = [(member, data.read() if data else None) for member, data in members]
        else:
            dirty = git("status", "--porcelain", "--", *files)
            version = f"{git('rev-parse', '--short', 'HEAD')}{'+changes' if dirty else ''}"
            contents = None
        with tarfile.open(archive, "w:gz") as out:
            if contents is None:
                for name in files:
                    out.add(REPO / name, arcname=name)
            else:
                for member, data in contents:
                    out.addfile(member, io.BytesIO(data) if data is not None else None)
            info = tarfile.TarInfo("VERSION")
            info.size = len(version.encode())
            out.addfile(info, io.BytesIO(version.encode()))

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        model = (self.model_name or "deepseek-flash").split("/", 1)[-1]
        key_name = "ANTHROPIC_API_KEY" if model.startswith("claude") else "DEEPSEEK_API_KEY" if model.startswith("deepseek") else "OPENAI_API_KEY"
        key = self._get_env(key_name)
        if not key:
            raise ValueError(f"Set {key_name} in the environment harbor runs in.")
        flags = self.build_cli_flags()
        secret = key
        upstream = next((origin for prefix, origin in UPSTREAMS.items() if model.startswith(prefix)), None)
        if self.options.key_proxy and upstream:
            others = [m for m in (self.options.reviewer, self.options.escalate) if m and not m.startswith(model.split("-")[0])]
            if others:
                raise ValueError(f"With the key proxy, jig's other models must be {model}'s provider's, not {others[0]}: or set key_proxy=false.")
            proxy = proxy_for(upstream, key)
            secret = proxy.token
            # DeepSeek's Anthropic-compatible API is under /anthropic; its OpenAI-compatible one, and Anthropic's, at the root.
            path = "/anthropic" if model.startswith("deepseek") and self.options.api != "openai" else ""
            flags += f" --base-url {shlex.quote(f'http://host.docker.internal:{proxy.port}{path}')}"
        if self.options.prompts == "mini":
            system, instruction = await self._mini_prompts(instruction, environment)
            flags += f" --system-prompt {shlex.quote(system)}"
        elif self.options.prompts:
            raise ValueError(f"Unknown prompts {self.options.prompts!r}: the choice is mini.")
        started = time.monotonic()
        reviewing = self.options.run_reviewer
        if reviewing and not isinstance(environment, DockerEnvironment):
            raise ValueError("run_reviewer needs Harbor's local Docker environment, to reach the task's container.")
        if reviewing and reviewing.split("-")[0] != model.split("-")[0]:
            raise ValueError(f"run_reviewer must be {model}'s provider's model, so that the key in hand reaches it, not {reviewing}.")
        # What the container holds before jig starts (jig's own install, say), so the review is told only what jig changed.
        before = await self._diff(environment) if reviewing else set()
        # The task reaches jig on stdin (jig -), not on the command line: models stop programs by matching
        # command lines (pkill -f server.py), and in milestone 10 that killed jig twice, through the task
        # in its arguments (which its process title can't hide under emulation) or in the shell's.
        await self._upload_text(environment, instruction, TASK_FILE)
        env = {key_name: secret, "NO_COLOR": "1", "JIG_HOME": "/logs/agent/jig-home"}
        await self.exec_as_agent(environment, command=self._jig(model, flags + self._time_limit(environment, started), TASK_FILE, "jig-stats.json"), env=env)
        if not reviewing:
            return
        feedback = await self._review(environment, reviewing, key_name, key, before, started)
        if feedback:
            # The review's problems, in the time left, as the next message of jig's own conversation.
            await self._upload_text(environment, feedback, REVIEW_FILE)
            limit = self._time_limit(environment, started)
            await self.exec_as_agent(environment, command=self._jig(model, f"{flags} --continue{limit}", REVIEW_FILE, "jig-stats-2.json"), env=env)

    def _time_limit(self, environment: BaseEnvironment, started: float) -> str:
        """jig's --time-limit: the agent's time left, less TIME_MARGIN. Nothing when the limit can't be worked out,
        or when the version of jig chosen has no --time-limit, which it would refuse as an unknown option."""
        try:
            limit = self._agent_timeout(environment)
            if not limit or not self._jig_has("--time-limit"):
                return ""
        except Exception:  # jig then runs as it did before it was given a limit, rather than not at all
            return ""
        return f" --time-limit {max(1, int(limit - (time.monotonic() - started) - TIME_MARGIN))}"

    def _jig_has(self, option: str) -> bool:
        """Whether the version of jig chosen (the working tree, or --ak ref) has an option."""
        if not self.options.ref:
            return option in (REPO / "src" / "cli.ts").read_text()
        cli = subprocess.run(["git", "show", f"{self.options.ref}:src/cli.ts"], cwd=REPO, check=True, capture_output=True, text=True)
        return option in cli.stdout

    @staticmethod
    def _jig(model: str, flags: str, task_file: str, stats: str) -> str:
        """jig in the container, the task on stdin. The container is the sandbox (--no-sandbox: jig's own would
        need bubblewrap and user namespaces in the container), so the whole file system is the project
        (--add-dir /), and nobody is there to approve tool calls (--yes). jig's home goes in the logs, so the
        session file (every message and tool input) comes back with the trial."""
        return (
            f"{LOAD_NODE} && node {INSTALL_DIR}/src/cli.ts --yes --no-sandbox --add-dir / --model {shlex.quote(model)} "
            f"--stats /logs/agent/{stats} {flags} -- - < {task_file} 2>&1 | tee -a /logs/agent/jig.txt"
        )

    @staticmethod
    async def _upload_text(environment: BaseEnvironment, text: str, path: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / "text.txt"
            file.write_text(text)
            await environment.upload_file(file, path)

    async def _review(self, environment: BaseEnvironment, reviewing: str, key_name: str, key: str, before: set[str], started: float) -> str | None:
        """Milestone 29's review, in a copy of the task's container; resolves to what goes back to jig, if
        anything. What it did is kept in the trial's logs: review-run.json (the adapter's part), review.json
        (jig review's verdict), review-stats.json and review-home (the review's session)."""
        # Absolute: Harbor's logs dir is relative to where it runs (-o eval/jobs), and jig review runs elsewhere.
        logs = self.logs_dir.resolve()
        record: dict = {"model": reviewing}
        trial = logs.parent.name
        tag = f"jig-review:{re.sub(r'[^a-z0-9_.-]', '-', trial.lower())[:120]}"
        labels = ["--label", "jig-review=1", "--label", f"jig-review.trial={trial}", "--label", f"jig-review.created={int(time.time())}"]
        copy = None
        try:
            limit = self._agent_timeout(environment)
            budget = min(REVIEW_SECONDS, limit / 4) if limit else REVIEW_SECONDS
            left = limit - (time.monotonic() - started) if limit else None
            record.update(limit=limit, budget=budget, left=None if left is None else round(left))
            if left is not None and left < 2 * budget:
                record["skipped"] = f"{left:.0f}s left, less than twice the review's {budget:.0f}s"
                return None
            await self._sweep()
            container = self._container(environment)
            changes = [line for line in await self._docker("diff", container) if line not in before]
            (logs / "review-changes.txt").write_text(changed_files(changes))
            # The copy: the container as jig left it, with no network, none of Harbor's mounts (/logs/verifier is
            # where the hidden tests write the reward) and the container's limits; it waits for commands.
            # A commit carries the container's compose labels, and they go blank in the image: with them a copy
            # would be the task's service main to Harbor's docker compose, and the image its project's, which
            # its `down --rmi local` at the end of the trial removes (in milestone 29's smoke test, the image
            # kept for eval/review_before.py).
            own = json.loads((await self._docker("inspect", "-f", "{{json .Config.Labels}}", container))[0]) or {}
            blank = [f'{key}=""' for key in own if key.startswith("com.docker.compose.")]
            clock = time.monotonic()
            await self._docker("commit", *[flag for label in [*labels[1::2], *blank] for flag in ("--change", f"LABEL {label}")], container, tag, timeout=600)
            record["commit_seconds"] = round(time.monotonic() - clock, 1)
            # The image's own platform, so that Docker doesn't print a warning into every re-run's output.
            platform = ["--platform", (await self._docker("inspect", "-f", "{{.Os}}/{{.Architecture}}", tag))[0]]
            limits = [*platform, *await self._limits(container)]
            user = ["-u", str(environment.default_user)] if environment.default_user is not None else []
            copy = (await self._docker("run", "-d", "--network", "none", *labels, *limits, *user, "--entrypoint", "sleep", tag, "infinity"))[0]
            workdir = environment.task_env_config.workdir or (await self._docker("inspect", "-f", "{{.Config.WorkingDir}}", tag))[0] or "/"
            # Inside the copy, a command the review's clock stopped is killed there too, if the image has timeout(1).
            stop = ["timeout", "-s", "KILL", str(int(budget))] if await self._has_timeout(copy) else []
            run_in_copy = ["docker", "exec", "-w", workdir, *user, copy, *stop, "bash", "-c"]
            fresh = ["docker", "run", "--rm", "--network", "none", *labels, *limits, *user, "-w", workdir]
            fresh += ["--entrypoint", "timeout", tag, "-s", "KILL", "90", "bash", "-c"] if stop else ["--entrypoint", "bash", tag, "-c"]
            sessions = sorted((logs / "jig-home" / "sessions").glob("*/*.jsonl"), key=lambda path: path.stat().st_mtime)
            if not sessions:
                record["skipped"] = "jig left no session"
                return None
            out = logs / "review.json"
            command = [
                "node", str(REPO / "src" / "cli.ts"), "review", "--session", str(sessions[-1]),
                "--changes", str(logs / "review-changes.txt"), "--workdir", workdir,
                "--exec", json.dumps(run_in_copy), *(["--verify-exec", json.dumps(fresh)] if self.options.recheck else []),
                "--model", reviewing, "--time-limit", str(int(budget)),
                "--stats", str(logs / "review-stats.json"), "--out", str(out),
            ]
            env = {**os.environ, key_name: key, "JIG_HOME": str(logs / "review-home"), "NO_COLOR": "1"}
            clock = time.monotonic()
            with open(logs / "review.txt", "wb") as log:
                process = await asyncio.create_subprocess_exec(*command, env=env, cwd=tempfile.gettempdir(), stdout=log, stderr=log)
                try:
                    code = await asyncio.wait_for(process.wait(), budget + 60)
                except BaseException:
                    process.kill()
                    raise
            record.update(review_seconds=round(time.monotonic() - clock, 1), exit=code)
            if code != 0 or not out.exists():
                record["failed"] = f"jig review exited with {code}: see review.txt"
                return None
            verdict = json.loads(out.read_text())
            record["sent_back"] = bool(verdict.get("feedback"))
            if verdict.get("feedback"):
                # The work as the review saw it stays, for eval/review_before.py to run the hidden tests on after
                # the trial: so the trial tells what the fix after the review changed.
                record.update(before_image=tag.replace("jig-review:", "jig-review-before:", 1), task_dir=str(Path(environment.environment_dir).parent))
                await self._docker("tag", tag, record["before_image"])
            return verdict.get("feedback")
        except Exception as err:  # a review that fails leaves the work as it is: it was only a check
            record["failed"] = f"{type(err).__name__}: {err}"
            return None
        finally:
            # Synchronous, so that it runs even when the trial's time limit cancels the review: the copy, any
            # fresh copy a re-run left, and the image.
            left_behind = subprocess.run(["docker", "ps", "-aq", "--filter", f"label=jig-review.trial={trial}"], capture_output=True, text=True).stdout.split()
            for args in ([["rm", "-f", *left_behind]] if left_behind else []) + [["rmi", "-f", tag]]:
                subprocess.run(["docker", *args], capture_output=True, timeout=120)
            (logs / "review-run.json").write_text(json.dumps(record, indent=2) + "\n")

    @staticmethod
    async def _docker(*args: str, timeout: float = 120) -> list[str]:
        """The docker CLI on the host: its output's lines, or an error saying why it failed."""
        process = await asyncio.create_subprocess_exec("docker", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(process.communicate(), timeout)
        except BaseException:
            process.kill()
            raise
        if process.returncode != 0:
            raise RuntimeError(f"docker {args[0]} failed: {err.decode().strip() or process.returncode}")
        return out.decode().splitlines()

    async def _diff(self, environment: BaseEnvironment) -> set[str]:
        """docker diff of the task's container; nothing, if it can't be had, rather than failing the trial."""
        try:
            return set(await self._docker("diff", self._container(environment)))
        except Exception:
            return set()

    @staticmethod
    def _container(environment: BaseEnvironment) -> str:
        """The task's container: the service main of the compose project Harbor names after the session."""
        project = _sanitize_docker_compose_project_name(environment.session_id)
        found = subprocess.run(
            ["docker", "ps", "-q", "--filter", f"label=com.docker.compose.project={project}", "--filter", "label=com.docker.compose.service=main"],
            capture_output=True, text=True, check=True,
        ).stdout.split()
        if len(found) != 1:
            raise RuntimeError(f"expected one container for {project}, found {len(found)}")
        return found[0]

    async def _limits(self, container: str) -> list[str]:
        """The task container's memory and CPU limits, for the copies; the memory at most what Docker has free
        beside the containers running (this Mac's VM has 3.3 GB, and a task container 2), since a copy that ran
        Docker out of memory could take the task's own processes with it."""
        memory, cpus = (int(n) for n in (await self._docker("inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}", container))[0].split())
        total = int((await self._docker("info", "-f", "{{.MemTotal}}"))[0])
        used = sum(to_bytes(row.split(" / ")[0]) for row in await self._docker("stats", "--no-stream", "--format", "{{.MemUsage}}"))
        free = total - used - COPY_MARGIN
        if free < MIN_COPY_MEMORY:
            raise RuntimeError(f"Docker has {free // 2**20} MiB free beside its containers, too little for a copy")
        return ["--memory", str(min(memory, free) if memory else free), *(["--cpus", str(cpus / 1e9)] if cpus else [])]

    async def _has_timeout(self, copy: str) -> bool:
        try:
            await self._docker("exec", copy, "sh", "-c", "command -v timeout")
            return True
        except RuntimeError:
            return False

    async def _sweep(self) -> None:
        """Copies a crashed trial left running, over three hours old (their memory is Docker's, and short)."""
        rows = await self._docker("ps", "-a", "--filter", "label=jig-review", "--format", '{{.ID}} {{.Label "jig-review.created"}}')
        old = [row.split()[0] for row in rows if len(row.split()) == 2 and time.time() - int(row.split()[1]) > 3 * 3600]
        if old:
            await self._docker("rm", "-f", *old)

    def _agent_timeout(self, environment: BaseEnvironment) -> float | None:
        """The agent's time limit, worked out as the trial does (harbor/trial/trial.py): the task's, or the job's
        override, at most the job's maximum, times its multiplier."""
        task = tomllib.loads((Path(environment.environment_dir).parent / "task.toml").read_text())
        config = json.loads((self.logs_dir.parent / "config.json").read_text())
        agent = config.get("agent") or {}
        base = agent.get("override_timeout_sec") or (task.get("agent") or {}).get("timeout_sec")
        if base is None:
            return None
        multiplier = config.get("agent_timeout_multiplier") or config.get("timeout_multiplier") or 1.0
        return min(base, agent.get("max_timeout_sec") or float("inf")) * multiplier

    async def _mini_prompts(self, instruction: str, environment: BaseEnvironment) -> tuple[str, str]:
        """mini-swe-agent's system prompt, and the task in its template, rendered as mini-swe-agent renders
        them: with Jinja, the task and the container's uname."""
        result = await environment.exec("uname -s; uname -r; uname -v; uname -m")
        system, release, version, machine = (result.stdout or "").strip().split("\n")
        values = {"task": instruction, "system": system, "release": release, "version": version, "machine": machine}
        templates = json.loads(MINI_PROMPTS.read_text())
        render = lambda name: jinja2.Template(templates[name], undefined=jinja2.StrictUndefined).render(**values)  # noqa: E731
        return render("system_template"), render("instance_template")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "jig-stats.json"
        if not path.exists():
            return
        stats = json.loads(path.read_text())
        # A second run, after milestone 29's review, and the review itself, count as this trial's too.
        runs = [stats, *(json.loads(p.read_text()) for p in (self.logs_dir / "jig-stats-2.json",) if p.exists())]
        review = self.logs_dir / "review-stats.json"
        reviews = [json.loads(review.read_text())] if review.exists() else []
        usage = {key: sum(s["usage"][key] for s in runs + reviews) for key in stats["usage"]}
        context.n_input_tokens = usage["input"] + usage["cacheWrite"] + usage["cacheRead"]
        context.n_cache_tokens = usage["cacheRead"]
        context.n_output_tokens = usage["output"]
        parts = []
        for s in runs + reviews:
            # Calls another model made for jig (the reviewer, or one that took over) at that model's prices.
            shares = [s[key] for key in ("escalated", "reviewed") if s.get(key)]
            own = {key: s["usage"][key] - sum(share["usage"][key] for share in shares) for key in s["usage"]}
            parts += [dollars(s["model"], own), *(dollars(share["model"], share["usage"]) for share in shares)]
        if None not in parts:
            context.cost_usd = sum(parts)
        keys = ("stop", "steps", "modelCalls", "subagentModelCalls", "toolCalls", "events", "seconds", "escalated", "reviewed")
        context.metadata = {key: stats.get(key) for key in keys if key in stats}
        # Whether jig stopped itself at --time-limit in either run, for the report: "stop" is the first run's only.
        context.metadata["time_limit"] = any(s.get("stop") == "time_limit" for s in runs)
        if (self.logs_dir / "review-run.json").exists():
            context.metadata["run_review"] = review_summary(self.logs_dir)


def changed_files(lines: list[str]) -> str:
    """docker diff's lines, for the reviewer: without what isn't the agent's work, a directory left out when
    something in it is listed, and the largest directories summed up when there are many."""
    entries = sorted({line for line in lines if len(line) > 2}, key=lambda line: line[2:])
    paths = [line[2:] for line in entries]
    leaves = [line for i, line in enumerate(entries) if not (i + 1 < len(paths) and paths[i + 1].startswith(paths[i] + "/"))]
    leaves = [line for line in leaves if not NOT_THE_WORK.search(line[2:])]
    if len(leaves) <= MAX_CHANGES:
        return "\n".join(leaves)
    groups: dict[str, list[str]] = {}
    for line in leaves:
        groups.setdefault("/".join(line[2:].split("/")[:4]), []).append(line)
    shown = [line for lines in groups.values() for line in (lines if len(lines) <= 5 else [summed_up(lines)])]
    return "\n".join(shown[:MAX_CHANGES] + ([f"… and {len(shown) - MAX_CHANGES} more"] if len(shown) > MAX_CHANGES else []))


def summed_up(lines: list[str]) -> str:
    """Many changes in one place as one line: their directory, and how many."""
    kinds = {line[0] for line in lines}
    return f"{kinds.pop() if len(kinds) == 1 else 'C'} {os.path.commonpath([line[2:] for line in lines])}/… ({len(lines)} files)"


def to_bytes(size: str) -> int:
    """docker stats' sizes, like 24.4MiB or 1.2GiB, in bytes."""
    number, unit = re.fullmatch(r"([\d.]+)\s*([kKMGT]?i?B)", size.strip()).groups()
    return int(float(number) * {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "TiB": 2**40, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}[unit])


def review_summary(logs: Path) -> dict:
    """What milestone 29's review did, from its files: the adapter's record and jig review's verdict."""
    summary = json.loads((logs / "review-run.json").read_text())
    verdict_file = logs / "review.json"
    if verdict_file.exists():
        verdict = json.loads(verdict_file.read_text())
        problems = verdict.get("problems") or []
        summary.update(
            verdict=verdict.get("verdict"),
            problems=len(problems),
            held=sum(1 for problem in problems if problem.get("held")),
            stop=verdict.get("stop"),
            steps=verdict.get("steps"),
        )
    return summary


def dollars(model: str, usage: dict) -> float | None:
    """What a model's tokens cost (jig's usage: input, cacheWrite, cacheRead, output), or None without a price."""
    prices = PRICES.get(model)
    if not prices:
        return None
    return ((usage["input"] + usage["cacheWrite"]) * prices[0] + usage["cacheRead"] * prices[1] + usage["output"] * prices[2]) / 1e6
