"""Harbor adapter: runs jig inside each task's container, for Terminal-Bench and other Harbor datasets.

    export DEEPSEEK_API_KEY=...
    PYTHONPATH=eval eval/.venv/bin/harbor run -d terminal-bench@2.0 -a jig_agent:Jig -m deepseek/deepseek-flash

jig comes from this checkout: the working tree, or a git ref given with --ak ref=m5. The API key is read
from the environment harbor runs in and handed to jig's process only; it is never written into the
container or the job's files.
"""

from __future__ import annotations

import io
import json
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Annotated, override

import jinja2
from pydantic import Field

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(__file__).resolve().parent.parent
MINI_PROMPTS = Path(__file__).resolve().parent / "mini-swe-agent-prompts.json"
INSTALL_DIR = "/installed-agent/jig"
TASK_FILE = "/installed-agent/task.txt"
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
    tools: Annotated[str | None, Cli("--tools")] = Field(
        default=None, description="jig's --tools: only these of its tools, e.g. bash"
    )
    prompts: str | None = Field(
        default=None, description="mini: mini-swe-agent's system prompt and task template instead of jig's"
    )
    api: Annotated[str | None, Cli("--api")] = Field(
        default=None, description="jig's --api: anthropic or openai (DeepSeek serves both)"
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
        if self.options.prompts == "mini":
            system, instruction = await self._mini_prompts(instruction, environment)
            flags += f" --system-prompt {shlex.quote(system)}"
        elif self.options.prompts:
            raise ValueError(f"Unknown prompts {self.options.prompts!r}: the choice is mini.")
        # The task reaches jig on stdin (jig -), not on the command line: models stop programs by matching
        # command lines (pkill -f server.py), and in milestone 10 that killed jig twice, through the task
        # in its arguments (which its process title can't hide under emulation) or in the shell's.
        with tempfile.TemporaryDirectory() as tmp:
            task = Path(tmp) / "task.txt"
            task.write_text(instruction)
            await environment.upload_file(task, TASK_FILE)
        # The container is the sandbox (--no-sandbox: jig's own would need bubblewrap and user namespaces
        # in the container), so the whole file system is the project (--add-dir /), and nobody is there
        # to approve tool calls (--yes). jig's home goes in the logs, so the session
        # file (every message and tool input) comes back with the trial.
        await self.exec_as_agent(
            environment,
            command=(
                f"{LOAD_NODE} && node {INSTALL_DIR}/src/cli.ts --yes --no-sandbox --add-dir / --model {shlex.quote(model)} "
                f"--stats /logs/agent/jig-stats.json {flags} -- - < {TASK_FILE} 2>&1 | tee /logs/agent/jig.txt"
            ),
            env={key_name: key, "NO_COLOR": "1", "JIG_HOME": "/logs/agent/jig-home"},
        )

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
        usage = stats["usage"]
        context.n_input_tokens = usage["input"] + usage["cacheWrite"] + usage["cacheRead"]
        context.n_cache_tokens = usage["cacheRead"]
        context.n_output_tokens = usage["output"]
        prices = PRICES.get(stats["model"])
        if prices:
            uncached = usage["input"] + usage["cacheWrite"]
            context.cost_usd = (uncached * prices[0] + usage["cacheRead"] * prices[1] + usage["output"] * prices[2]) / 1e6
        keys = ("stop", "steps", "modelCalls", "subagentModelCalls", "toolCalls", "seconds")
        context.metadata = {key: stats.get(key) for key in keys}
