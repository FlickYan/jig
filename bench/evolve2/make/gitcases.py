"""Ground truth for the ignore task: real git, on a real repository."""
import os, subprocess, tempfile

def git_ignored(patterns, paths):
    """paths: list of (path, is_dir). Returns {(path, is_dir): bool} as git decides, each in a fresh repository."""
    out = {}
    for path, is_dir in paths:
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "core.ignorecase", "false"], cwd=repo, check=True)
            with open(os.path.join(repo, ".gitignore"), "w") as f:
                f.write("\n".join(patterns) + "\n")
            full = os.path.join(repo, path)
            if is_dir:
                os.makedirs(full, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(full), exist_ok=True)
                open(full, "w").close()
            # Without a trailing slash: check-ignore matches "dir/" literally (abc/** matches "abc/"), while
            # git's own traversal asks about "abc", a directory it has seen on disk.
            out[(path, is_dir)] = subprocess.run(["git", "check-ignore", "-q", "--", path], cwd=repo).returncode == 0
    return out

CASES = [
    # (patterns, [(path, is_dir), ...])
    (["*.log"], [("debug.log", False), ("logs/debug.log", False), ("debug.log.txt", False), ("a/b/c.log", False)]),
    (["/todo"], [("todo", False), ("src/todo", False)]),
    (["doc/frotz"], [("doc/frotz", False), ("a/doc/frotz", False)]),
    (["frotz"], [("frotz", False), ("a/b/frotz", False), ("frotz2", False), ("frotz/x.txt", False)]),
    (["build/"], [("build", True), ("build", False), ("build/out.o", False), ("src/build/x.o", False), ("src/build", False)]),
    (["/build/"], [("build", True), ("sub/build", True), ("build/x", False), ("sub/build/x", False)]),
    (["*.log", "!keep.log"], [("keep.log", False), ("a/keep.log", False), ("x.log", False)]),
    (["!keep.log", "*.log"], [("keep.log", False)]),
    (["logs/", "!logs/keep.txt"], [("logs/keep.txt", False), ("logs/x.txt", False)]),
    (["logs/*", "!logs/keep.txt"], [("logs/keep.txt", False), ("logs/x.txt", False), ("logs", True)]),
    (["*", "!*/", "!*.py"], [("src/a.py", False), ("src/a.txt", False), ("a.py", False), ("README", False), ("src", True)]),
    (["**/foo"], [("foo", False), ("a/b/foo", False), ("a/foo/bar", False)]),
    (["abc/**"], [("abc/x", False), ("abc/x/y", False), ("abc", True), ("xabc/x", False)]),
    (["a/**/b"], [("a/b", False), ("a/x/b", False), ("a/x/y/b", False), ("x/a/b", False), ("a/b/c", False)]),
    (["logs/**", "!logs/keep/"], [("logs/keep", True), ("logs/keep/a.txt", False), ("logs/other.txt", False)]),
    (["file?.txt"], [("file1.txt", False), ("file10.txt", False), ("file.txt", False), ("d/fileA.txt", False)]),
    (["[abc]*.txt"], [("a1.txt", False), ("d1.txt", False), ("c.txt", False)]),
    (["[!0-9]*.csv"], [("x.csv", False), ("9x.csv", False)]),
    (["data[0-9][0-9]"], [("data07", False), ("data7", False), ("data7x", False)]),
    (["\\#notes", "#comment"], [("#notes", False), ("#comment", False)]),
    (["\\!important"], [("!important", False), ("important", False)]),
    (["name\\ "], [("name ", False), ("name", False)]),
    (["spaced   "], [("spaced", False), ("spaced   ", False)]),
    (["\\*.md"], [("*.md", False), ("a.md", False)]),
    (["*.LOG"], [("x.log", False), ("X.LOG", False)]),
    (["a**b"], [("axxb", False), ("a/b", False), ("ab", False)]),
    (["", "# just a comment", "   ", "*.tmp"], [("x.tmp", False), ("x.tmpl", False)]),
    (["build/", "!build/"], [("build/x", False), ("build", True)]),
    (["vendor/", "!vendor/keep/", "!vendor/keep/*"], [("vendor/keep/a.go", False), ("vendor/b.go", False)]),
    (["out", "!out/keep"], [("out/keep", False), ("out", True)]),
    (["docs/*.txt"], [("docs/a.txt", False), ("docs/sub/a.txt", False), ("x/docs/a.txt", False)]),
    (["**/cache/", "!**/cache/README"], [("a/cache/README", False), ("cache", True), ("a/b/cache/data", False)]),
    (["*.o", "!lib/*.o", "lib/bad.o"], [("lib/good.o", False), ("lib/bad.o", False), ("main.o", False), ("lib/sub/x.o", False)]),
]

if __name__ == "__main__":
    for patterns, paths in CASES:
        result = git_ignored(patterns, paths)
        print(patterns, {f"{p}{'/' if d else ''}": v for (p, d), v in result.items()})
