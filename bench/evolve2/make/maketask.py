"""Writes one task of the second evolve suite: task.json, repo/, tests/test_hidden.py, solution/, solve.sh."""
import json, os, pathlib, shutil, subprocess, tempfile, textwrap

SOLVE = '#!/bin/bash\n# Reference solution, used by `--agent oracle` to prove the task is solvable.\nset -e\ncp -R "$TASK_DIR/solution/." .\n'
CHECK = "PYTHONPATH=. python3 -m unittest discover -s bench_tests"
ROOT = pathlib.Path(__file__).resolve().parents[1] / "tasks"

def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip("\n"))

def task(name, instruction, tags, files, hidden, solution, check=CHECK):
    base = ROOT / name
    if base.exists():
        shutil.rmtree(base)
    for rel, text in files.items():
        _write(base / "repo" / rel, text)
    _write(base / "tests" / "test_hidden.py", hidden)
    for rel, text in solution.items():
        _write(base / "solution" / rel, text)
    (base / "solve.sh").write_text(SOLVE)
    os.chmod(base / "solve.sh", 0o755)
    (base / "task.json").write_text(json.dumps({"instruction": instruction, "check": check, "tags": tags}, indent=2) + "\n")
    validate(name)

def validate(name):
    """The hidden tests must fail on the starting repo and pass with the reference solution."""
    base = ROOT / name
    check = json.loads((base / "task.json").read_text())["check"]
    # The starting project must be valid Python: the agent starts from it.
    broken = [str(path.relative_to(base)) for path in (base / "repo").rglob("*.py") if subprocess.run(["python3", "-c", "import ast, sys; ast.parse(open(sys.argv[1]).read())", str(path)], capture_output=True).returncode]
    print(f"{name:20} {'parses':7} {'BAD ' + ', '.join(broken) if broken else 'ok'}")
    for mode in ("noop", "oracle"):
        with tempfile.TemporaryDirectory() as work:
            shutil.copytree(base / "repo", work, dirs_exist_ok=True)
            shutil.copytree(base / "tests", pathlib.Path(work) / "bench_tests")
            if mode == "oracle":
                shutil.copytree(base / "solution", work, dirs_exist_ok=True)
            run = subprocess.run(["bash", "-c", check], cwd=work, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            ok = (run.returncode != 0) if mode == "noop" else (run.returncode == 0)
            print(f"{name:20} {mode:7} {'ok' if ok else 'BAD'}")
            if not ok:
                print((run.stdout + run.stderr)[-3000:])
            if mode == "oracle" and (base / "repo" / "tests").is_dir():
                # The project's own tests must agree with the reference solution: they are what the agent sees.
                own = subprocess.run(["bash", "-c", "PYTHONPATH=. python3 -m unittest discover -s tests"], cwd=work, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
                print(f"{name:20} {'visible':7} {'ok' if own.returncode == 0 else 'BAD'}")
                if own.returncode != 0:
                    print((own.stdout + own.stderr)[-3000:])
