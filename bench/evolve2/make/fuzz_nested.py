import importlib.util, os, random, subprocess, tempfile
spec = importlib.util.spec_from_file_location("ignore", "ignore_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rng = random.Random(11)
names = ["a", "b", "log", "x.log", "keep", "build", "src"]
dirs = ["", "src", "src/a", "a", "a/b"]
def comp(): return rng.choice(["a", "b", "*", "*.log", "x.log", "keep", "build", "src", "**", "[ab]"])
def pattern():
    p = "/".join(comp() for _ in range(rng.choice([1, 1, 2])))
    if rng.random() < 0.25: p = "/" + p
    if rng.random() < 0.25: p += "/"
    if rng.random() < 0.35: p = "!" + p
    return p
bad = n = 0
for trial in range(500):
    files = {d: [pattern() for _ in range(rng.choice([1, 2]))] for d in rng.sample(dirs, rng.choice([1, 2, 3]))}
    path = rng.choice(["src/", "src/a/", "a/", "a/b/", ""]) + "/".join(rng.choice(names) for _ in range(rng.choice([1, 2])))
    is_dir = rng.random() < 0.25
    with tempfile.TemporaryDirectory() as repo:
        run = lambda *a: subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True)
        run("init", "-q"); run("config", "core.ignorecase", "false")
        try:
            for d, lines in files.items():
                os.makedirs(os.path.join(repo, d), exist_ok=True)
                open(os.path.join(repo, d, ".gitignore"), "w").write("\n".join(lines) + "\n")
            full = os.path.join(repo, path)
            if is_dir: os.makedirs(full, exist_ok=True)
            else: os.makedirs(os.path.dirname(full), exist_ok=True); open(full, "w").close()
        except OSError:
            continue
        if os.path.basename(path) == ".gitignore": continue
        truth = run("check-ignore", "-q", "--", path).returncode == 0
    n += 1
    mine = m.is_ignored(path, files, is_dir)
    if mine != truth:
        bad += 1
        if bad <= 10: print("MISMATCH", files, path + ("/" if is_dir else ""), "git:", truth, "mine:", mine)
print(n, "random layouts,", bad, "mismatches")
