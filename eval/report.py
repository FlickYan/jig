"""Summarizes Harbor jobs as Markdown: one row per job (an agent and its settings), then one per task.

    python3 eval/report.py eval/jobs/tb-jig eval/jobs/tb-mini    # Harbor job directories
    python3 eval/report.py --save eval/results eval/jobs/tb-*    # also keep a summary of each, to commit
    python3 eval/report.py eval/results/*.json                   # the report again, from the summaries
    python3 eval/report.py --only eval/ablation-subset.txt eval/results/tb-jig.json eval/results/abl-*.json
                                                                 # only the tasks in a list

Cost comes from the token counts and one price table, the same for every agent: mini-swe-agent's own
cost tracking doesn't know every model, and jig's is computed the same way in its adapter.

Terminal-Bench's tasks, with their tests and reference solutions, are public on GitHub, and the task
containers can reach the internet. A trial in which the agent fetched anything from the benchmark's
repositories counts as failed, whatever the verifier said: both agents did it now and then.
"""

import json
import random
import re
import statistics
import sys
from pathlib import Path

# The benchmark's own repositories: Terminal-Bench 1 (laude-institute, now harbor-framework) and 2.
BENCHMARK_REPOSITORY = re.compile(r"(harbor-framework|laude-institute)/terminal-bench", re.I)

PRICES = {  # USD per million tokens: uncached input, cached input, output
    "deepseek-flash": (0.3, 0.006, 1.2),
    "deepseek-v4-pro": (1.32, 0.044, 3.96),
}


def trials(job: Path) -> list[dict]:
    found = []
    # Several job directories can make one run, when a run was split up: name them "a+b".
    for path in sorted(path for part in job.name.split("+") for path in (job.parent / part).glob("*/result.json")):
        result = json.loads(path.read_text())
        agent = result.get("agent_result") or {}
        model = ((result.get("agent_info") or {}).get("model_info") or {}).get("name", "")
        exception = (result.get("exception_info") or {}).get("exception_type")
        execution = result.get("agent_execution") or {}
        found.append({
            "task": result["task_name"],
            "job": path.parent.parent.name,
            "version": (result.get("agent_info") or {}).get("version"),
            "passed": ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward") == 1.0,
            "error": exception,
            "turns": turns(path.parent, agent),
            "input": agent.get("n_input_tokens") or 0,
            "cached": agent.get("n_cache_tokens") or 0,
            "output": agent.get("n_output_tokens") or 0,
            "model": model,
            "seconds": seconds(execution),
            "trial": path.parent.name,
            "looked_up": any(BENCHMARK_REPOSITORY.search(command) for command in commands(path.parent)),
            # jig's calls on another model (its reviewer, or one that took over), priced apart.
            "shares": [share for key in ("escalated", "reviewed") if (share := (agent.get("metadata") or {}).get(key))],
        })
    return found


def commands(trial: Path) -> list[str]:
    """What the agent ran: the tool inputs in jig's session file, or the bash commands in mini-swe-agent's
    trajectory. Runs from before jig kept its session in the logs have only its transcript, which shows
    every command in full, along with their output."""
    agent = trial / "agent"
    sessions = sorted((agent / "jig-home" / "sessions").glob("*/*.jsonl"))
    if sessions:
        inputs = []
        for line in sessions[0].read_text().splitlines():
            content = (json.loads(line).get("message") or {}).get("content")
            inputs += [json.dumps(block["input"]) for block in content or [] if isinstance(block, dict) and block.get("type") == "tool_use"]
        return inputs
    if (agent / "jig.txt").exists():
        return [(agent / "jig.txt").read_text(errors="replace")]
    trajectory = agent / "mini-swe-agent.trajectory.json"
    if trajectory.exists():
        messages = json.loads(trajectory.read_text()).get("messages") or []
        return [call["function"]["arguments"] for message in messages for call in message.get("tool_calls") or []]
    return []


def solved(trial: dict) -> bool:
    """Passed, without the benchmark's own files."""
    return trial["passed"] and not trial.get("looked_up")


def turns(trial: Path, agent: dict) -> int | None:
    """Model calls: from jig's stats, or the agent steps of an ATIF trajectory (mini-swe-agent)."""
    calls = (agent.get("metadata") or {}).get("modelCalls")
    if calls is not None:
        return calls
    trajectory = trial / "agent" / "trajectory.json"
    if trajectory.exists():
        steps = json.loads(trajectory.read_text()).get("steps") or []
        return sum(1 for step in steps if step.get("source") == "agent")
    return None


def seconds(span: dict) -> float | None:
    from datetime import datetime

    if not span.get("started_at") or not span.get("finished_at"):
        return None
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
    return (parse(span["finished_at"]) - parse(span["started_at"])).total_seconds()


def cost(trial: dict) -> float | None:
    """At the model's prices, but for the tokens jig spent on another model (trial["shares"]), at its own."""
    def dollars(model: str, uncached: int, cached: int, output: int) -> float | None:
        prices = PRICES.get(model)
        return None if not prices else (uncached * prices[0] + cached * prices[1] + output * prices[2]) / 1e6

    shares = [share["usage"] | {"model": share["model"]} for share in trial.get("shares") or []]
    uncached = trial["input"] - trial["cached"] - sum(s["input"] + s["cacheWrite"] for s in shares)
    cached = trial["cached"] - sum(s["cacheRead"] for s in shares)
    output = trial["output"] - sum(s["output"] for s in shares)
    parts = [dollars(trial["model"], uncached, cached, output)]
    parts += [dollars(s["model"], s["input"] + s["cacheWrite"], s["cacheRead"], s["output"]) for s in shares]
    return None if None in parts else sum(parts)


def label(job: Path) -> str:
    config = json.loads((job.parent / job.name.split("+")[0] / "config.json").read_text())
    agent = config["agents"][0]
    name = agent.get("name") or agent.get("import_path") or "?"
    name = "jig" if "jig" in name else name
    kwargs = agent.get("kwargs") or {}
    settings = ", ".join(f"{key}={value}" for key, value in sorted(kwargs.items()))
    return f"{name}{f' ({settings})' if settings else ''}"


def pass_rates(found: list[dict]) -> dict[str, float]:
    """The share of each task's attempts that passed (without looking up the benchmark)."""
    tasks: dict[str, list[bool]] = {}
    for trial in found:
        tasks.setdefault(trial["task"], []).append(solved(trial))
    return {task: sum(results) / len(results) for task, results in tasks.items()}


def interval(values: list[float], resamples: int = 10_000) -> tuple[float, float]:
    """A 95% bootstrap interval for the mean of per-task values, resampling tasks: attempts at one task
    are not independent of each other, so tasks are the unit."""
    rng = random.Random(0)
    means = sorted(statistics.mean(rng.choices(values, k=len(values))) for _ in range(resamples))
    return means[int(0.025 * resamples)], means[int(0.975 * resamples) - 1]


def mean(values: list) -> float | None:
    values = [value for value in values if value is not None]
    return statistics.mean(values) if values else None


def fmt(value, kind: str) -> str:
    if value is None:
        return "-"
    if kind == "money":
        return f"${value:.3f}"
    if kind == "tokens":
        return f"{value / 1000:,.0f}k"
    if kind == "time":
        return f"{value / 60:.1f} min"
    return f"{value:.1f}"


def load(arg: str) -> tuple[str, str, list[dict]]:
    """A run: from a saved summary (.json), or from Harbor job directories ("dir" or "dir+other")."""
    path = Path(arg)
    if path.suffix == ".json":
        saved = json.loads(path.read_text())
        return saved["name"], saved["agent"], saved["trials"]
    return path.name.split("+")[0], label(path), trials(path)


def main(args: list[str]) -> None:
    save = only = None
    while args[:1] in (["--save"], ["--only"]):
        if args[0] == "--save":
            save = Path(args[1])
        else:
            only = {line.strip() for line in Path(args[1]).read_text().splitlines() if line.strip() and not line.startswith("#")}
        args = args[2:]
    jobs = args or [str(p) for p in sorted(Path("eval/jobs").iterdir()) if (p / "config.json").exists()]
    runs = [load(arg) for arg in jobs]
    if only:
        runs = [(name, agent, [t for t in found if t["task"] in only]) for name, agent, found in runs]
    if save:
        save.mkdir(parents=True, exist_ok=True)
        for name, agent, found in runs:
            summary = {"name": name, "agent": agent, "trials": [trial | {"cost": cost(trial)} for trial in found]}
            (save / f"{name}.json").write_text(json.dumps(summary, indent=1) + "\n")
    print("| job | agent | passed | 95% CI | looked up | timed out | other errors | turns | tokens in | tokens out | cost | agent time |")
    print("|-----|-------|--------|--------|-----------|-----------|--------------|-------|-----------|------------|------|------------|")
    for job, name, found in runs:
        if not found:
            continue
        passed = sum(solved(trial) for trial in found)
        looked = [trial for trial in found if trial.get("looked_up")]
        looked_up = f"{len(looked)} ({sum(t['passed'] for t in looked)} passed)" if looked else "0"
        timeouts = sum(trial["error"] == "AgentTimeoutError" for trial in found)
        others = sum(bool(trial["error"]) and trial["error"] != "AgentTimeoutError" for trial in found)
        low, high = interval(list(pass_rates(found).values()))
        print(
            f"| {job} | {name} | {passed}/{len(found)} ({passed / len(found):.0%}) | {low:.0%}–{high:.0%} | {looked_up} | {timeouts} | {others} "
            f"| {fmt(mean([t['turns'] for t in found]), 'num')} | {fmt(mean([t['input'] for t in found]), 'tokens')} "
            f"| {fmt(mean([t['output'] for t in found]), 'tokens')} | {fmt(mean([cost(t) for t in found]), 'money')} "
            f"| {fmt(mean([t['seconds'] for t in found]), 'time')} |"
        )
    print("\nAverages are per attempt. The 95% interval resamples tasks (each task's share of passed attempts).")
    print("\"Looked up\": attempts that fetched the benchmark's own files from GitHub; they count as failed.")
    named = [(job, found) for job, _, found in runs if found]
    if len(named) > 1:
        first_job, first = named[0]
        base = pass_rates(first)
        print("\nDifferences, paired by task (only tasks both runs attempted):\n")
        for job, found in named[1:]:
            rates = pass_rates(found)
            common = sorted(set(base) & set(rates))
            if not common:
                print(f"- {job} and {first_job} have no tasks in common")
                continue
            diffs = [rates[task] - base[task] for task in common]
            low, high = interval(diffs)
            print(f"- {job} minus {first_job}: {statistics.mean(diffs) * 100:+.0f} points (95% CI {low * 100:+.0f} to {high * 100:+.0f}), over {len(common)} tasks")
    print("\nPer task (✓ passed, ✗ failed, ⏱ hit the time limit, ! agent error, ⊘ looked up the benchmark):\n")
    tasks = sorted({trial["task"] for _, _, found in runs for trial in found})
    print("| task | " + " | ".join(job for job, _, _ in runs) + " |")
    print("|------|" + "|".join("---" for _ in runs) + "|")
    for task in tasks:
        cells = []
        for _, _, found in runs:
            marks = []
            for trial in (t for t in found if t["task"] == task):
                error = trial["error"]
                marks.append("⊘" if trial.get("looked_up") else "✓" if trial["passed"] else "⏱" if error == "AgentTimeoutError" else "!" if error else "✗")
            cells.append("".join(marks) or " ")
        print(f"| {task} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main(sys.argv[1:])
