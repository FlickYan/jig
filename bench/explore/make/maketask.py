"""Writes one task of the exploration suite (task.json, repo/, an optional setup.sh, tests/test_hidden.py,
solution/, solve.sh) and checks it four ways, as bench/run.ts will use it: the starting project parses,
the hidden tests fail on it, they pass with the reference solution, and the project's own tests agree."""
import json, os, pathlib, shutil, subprocess, tempfile, textwrap

SOLVE = '#!/bin/bash\n# Reference solution, used by `--agent oracle` to prove the task is solvable.\nset -e\ncp -R "$TASK_DIR/solution/." .\n'
CHECK = "PYTHONPATH=. python3 -m unittest discover -s bench_tests"
ROOT = pathlib.Path(__file__).resolve().parents[1] / "tasks"
ENV = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "GIT_AUTHOR_NAME": "jig bench", "GIT_AUTHOR_EMAIL": "bench@example.com",
       "GIT_COMMITTER_NAME": "jig bench", "GIT_COMMITTER_EMAIL": "bench@example.com"}


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip("\n"))


def task(name, instruction, tags, files, hidden, solution, setup=None, check=CHECK, remove=()):
    """`setup` is a bash script run in the project after its first commit (to give it history); `remove`
    lists files the reference solution deletes."""
    base = ROOT / name
    if base.exists():
        shutil.rmtree(base)
    for rel, text in files.items():
        _write(base / "repo" / rel, text)
    _write(base / "tests" / "test_hidden.py", hidden)
    for rel, text in solution.items():
        _write(base / "solution" / rel, text)
    solve = SOLVE + "".join(f"rm -f {path}\n" for path in remove)
    (base / "solve.sh").write_text(solve)
    os.chmod(base / "solve.sh", 0o755)
    if setup:
        _write(base / "setup.sh", setup)
        os.chmod(base / "setup.sh", 0o755)
    (base / "task.json").write_text(json.dumps({"instruction": instruction, "check": check, "tags": tags}, indent=2) + "\n")
    validate(name)


def prepare(base, work):
    """The project as an attempt starts from it: copied, committed, and the setup script run."""
    shutil.copytree(base / "repo", work, dirs_exist_ok=True)
    subprocess.run(["bash", "-c", "git init -q -b main && git add -A && git commit -qm 'Starting point'"], cwd=work, env=ENV, check=True)
    if (base / "setup.sh").exists():
        subprocess.run(["bash", str(base / "setup.sh")], cwd=work, env={**ENV, "TASK_DIR": str(base)}, check=True, capture_output=True)


def validate(name):
    base = ROOT / name
    check = json.loads((base / "task.json").read_text())["check"]
    broken = [str(path.relative_to(base)) for path in (base / "repo").rglob("*.py") if subprocess.run(["python3", "-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", str(path)], capture_output=True).returncode]
    print(f"{name:22} {'parses':7} {'BAD ' + ', '.join(broken) if broken else 'ok'}")
    for mode in ("noop", "oracle"):
        with tempfile.TemporaryDirectory() as work:
            prepare(base, work)
            if mode == "oracle":
                subprocess.run(["bash", str(base / "solve.sh")], cwd=work, env={**ENV, "TASK_DIR": str(base)}, check=True)
            shutil.copytree(base / "tests", pathlib.Path(work) / "bench_tests")
            run = subprocess.run(["bash", "-c", check], cwd=work, capture_output=True, text=True, env=ENV)
            ok = (run.returncode != 0) if mode == "noop" else (run.returncode == 0)
            print(f"{name:22} {mode:7} {'ok' if ok else 'BAD'}")
            if not ok:
                print((run.stdout + run.stderr)[-3000:])
            if mode == "oracle" and (pathlib.Path(work) / "tests").is_dir():
                own = subprocess.run(["bash", "-c", "PYTHONPATH=. python3 -m unittest discover -s tests"], cwd=work, capture_output=True, text=True, env=ENV)
                print(f"{name:22} {'visible':7} {'ok' if own.returncode == 0 else 'BAD'}")
                if own.returncode != 0:
                    print((own.stdout + own.stderr)[-3000:])
