import os, subprocess, tempfile
def probe(files, paths):
    """files: {dir: lines} for .gitignore files ('' = the root). paths: [(path, is_dir)]."""
    out = {}
    for path, is_dir in paths:
        with tempfile.TemporaryDirectory() as repo:
            run = lambda *a: subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True)
            run("init", "-q"); run("config", "core.ignorecase", "false")
            for d, lines in files.items():
                os.makedirs(os.path.join(repo, d), exist_ok=True)
                open(os.path.join(repo, d, ".gitignore"), "w").write("\n".join(lines) + "\n")
            full = os.path.join(repo, path)
            if is_dir: os.makedirs(full, exist_ok=True)
            else: os.makedirs(os.path.dirname(full), exist_ok=True); open(full, "w").close()
            out[path + ("/" if is_dir else "")] = run("check-ignore", "-q", "--", path).returncode == 0
    return out
if __name__ == "__main__":
    print(probe({"": ["*.log"], "src": ["!keep.log"]}, [("src/keep.log", False), ("keep.log", False), ("src/a.log", False)]))
    print(probe({"": ["build/"], "src": ["/out", "gen/"]}, [("src/out", False), ("out", False), ("src/x/out", False), ("src/gen/a.c", False), ("gen/a.c", False)]))
    print(probe({"": ["!*.txt"], "docs": ["*.txt"]}, [("docs/a.txt", False), ("a.txt", False)]))
    print(probe({"": ["docs/"], "docs": ["!keep.md"]}, [("docs/keep.md", False)]))
    print(probe({"src": ["sub/*.tmp"]}, [("src/sub/a.tmp", False), ("sub/a.tmp", False), ("src/x/sub/a.tmp", False)]))
    print(probe({"a": ["b/c"], "": ["!a/b/c"]}, [("a/b/c", False)]))
    print(probe({"": ["a/b/c"], "a": ["!b/c"]}, [("a/b/c", False)]))
    print(probe({"a/b": ["*"], "a": ["!b/keep"]}, [("a/b/keep", False), ("a/b/other", False)]))
