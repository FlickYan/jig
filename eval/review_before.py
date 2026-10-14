"""Milestone 29: the hidden tests on the work as the review saw it, for the trials whose review sent problems
back, so that each such trial tells what the fix after the review did: the reward before it (here) and
after it (the trial's own).

    eval/.venv/bin/python eval/review_before.py eval/jobs/<job> [...]

The adapter keeps that work as an image (jig-review-before:<trial>). This runs the task's tests on a container
from it as Harbor's verifier does (the tests in /tests, `bash /tests/test.sh`, the reward from /logs/verifier),
with the network the tests may need to install their tools, records the reward in the trial's
agent/review-before.json, and removes the image. A trial already done is only reported.

The image has the files, not the programs the agent left running: where the tests need one, they fail here
though the trial might have passed without the review, so a "before" of 0 there doesn't show that the fix
after the review helped.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import tomllib
from pathlib import Path


def docker(*args: str, timeout: float | None = 300, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, check=check)


def reward_of(container: str) -> float | None:
    """The reward the tests wrote: reward.json's (its "reward", or its only value), or reward.txt's."""
    found = docker("exec", container, "cat", "/logs/verifier/reward.json", check=False)
    if found.returncode == 0 and found.stdout.strip():
        rewards = json.loads(found.stdout)
        return float(rewards.get("reward", next(iter(rewards.values()))) if isinstance(rewards, dict) else rewards)
    found = docker("exec", container, "cat", "/logs/verifier/reward.txt", check=False)
    return float(found.stdout.strip()) if found.returncode == 0 and found.stdout.strip() else None


def before(trial: Path) -> dict | None:
    """The reward before the review's fix, measured now if it hasn't been; None for a trial with nothing kept."""
    agent = trial / "agent"
    done = agent / "review-before.json"
    if done.exists():
        return json.loads(done.read_text())
    record_file = agent / "review-run.json"
    record = json.loads(record_file.read_text()) if record_file.exists() else {}
    image = record.get("before_image")
    if not image or docker("image", "inspect", image, check=False).returncode != 0:
        return None
    task = Path(record["task_dir"])
    config = tomllib.loads((task / "task.toml").read_text())
    verifier = config.get("verifier") or {}
    resources = config.get("environment") or {}
    platform = docker("inspect", "-f", "{{.Os}}/{{.Architecture}}", image).stdout.strip()
    labels = json.loads(docker("inspect", "-f", "{{json .Config.Labels}}", image).stdout) or {}
    # Not the task's compose service main to Docker Compose, whatever the image's labels say.
    blank = [flag for key in labels if key.startswith("com.docker.compose.") for flag in ("--label", f"{key}=")]
    limits = [*(["--memory", str(resources["memory"]).lower()] if resources.get("memory") else []), *(["--cpus", str(resources["cpus"])] if resources.get("cpus") else [])]
    name = f"jig-review-before-{int(time.time() * 1000)}"
    docker("run", "-d", "--name", name, "--platform", platform, *blank, *limits, "--label", "jig-review=1", "--label", f"jig-review.created={int(time.time())}", "--entrypoint", "sleep", image, "infinity")
    try:
        docker("exec", "-u", "root", name, "mkdir", "-p", "/tests", "/logs/verifier")
        docker("cp", f"{task / 'tests'}/.", f"{name}:/tests")
        env = [flag for key, value in (verifier.get("env") or {}).items() for flag in ("-e", f"{key}={value}")]
        clock = time.monotonic()
        try:
            ran = docker("exec", *env, name, "bash", "-c", "bash /tests/test.sh > /logs/verifier/test-stdout.txt 2>&1", timeout=verifier.get("timeout_sec", 900), check=False)
            exit_code: int | str = ran.returncode
        except subprocess.TimeoutExpired:
            exit_code = "timed out"
        output = docker("exec", name, "tail", "-c", "3000", "/logs/verifier/test-stdout.txt", check=False).stdout
        result = {"reward": reward_of(name), "exit": exit_code, "seconds": round(time.monotonic() - clock, 1), "output": output}
    finally:
        docker("rm", "-f", name, check=False)
    done.write_text(json.dumps(result, indent=2) + "\n")
    docker("rmi", image, check=False)
    return result


def after(trial: Path) -> float | None:
    result = json.loads((trial / "result.json").read_text()) if (trial / "result.json").exists() else {}
    return ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward")


if __name__ == "__main__":
    for job in map(Path, sys.argv[1:]):
        for trial in sorted(path for path in job.iterdir() if (path / "agent").is_dir()):
            found = before(trial)
            if found is not None:
                print(f"{trial.name}: before the review's fix {found['reward']}, after it {after(trial)}")
