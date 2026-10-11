import importlib.util, random, os, subprocess, tempfile
spec = importlib.util.spec_from_file_location("ignore", "ignore_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rng = random.Random(7)
names = ["a", "b", "ab", "log", "x.log", "keep", "build", "doc"]
def comp():
    return rng.choice(["a", "b", "*", "?", "a*", "*.log", "[ab]", "[!a]*", "x.log", "keep", "build", "doc", "**"])
def pattern():
    parts = [comp() for _ in range(rng.choice([1, 1, 2, 3]))]
    p = "/".join(parts)
    if rng.random() < 0.2: p = "/" + p
    if rng.random() < 0.25: p += "/"
    if rng.random() < 0.3: p = "!" + p
    return p
def path():
    return "/".join(rng.choice(names) for _ in range(rng.choice([1, 2, 2, 3])))
bad = n = 0
for trial in range(400):
    patterns = [pattern() for _ in range(rng.choice([1, 2, 3]))]
    p, is_dir = path(), rng.random() < 0.3
    with tempfile.TemporaryDirectory() as repo:
        subprocess.run(["git", "init", "-q"], cwd=repo); subprocess.run(["git", "config", "core.ignorecase", "false"], cwd=repo)
        open(os.path.join(repo, ".gitignore"), "w").write("\n".join(patterns) + "\n")
        full = os.path.join(repo, p)
        try:
            if is_dir: os.makedirs(full)
            else: os.makedirs(os.path.dirname(full), exist_ok=True); open(full, "w").close()
        except OSError:
            continue
        g = subprocess.run(["git", "check-ignore", "-q", "--", p], cwd=repo).returncode == 0
    n += 1
    mine = m.is_ignored(p, patterns, is_dir)
    if mine != g:
        bad += 1
        if bad <= 15: print("MISMATCH", patterns, p + ("/" if is_dir else ""), "git:", g, "mine:", mine)
print(f"{n} random queries, {bad} mismatches")
