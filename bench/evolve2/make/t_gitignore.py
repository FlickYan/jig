import ast, importlib.util
from maketask import task
from gitcases import CASES
from nestedcases import NESTED
from probe_nested import probe

spec = importlib.util.spec_from_file_location("ignore", "ignore_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
truth = {}
for line in open("git-truth.txt"):
    pats, res = line.split("] {", 1)
    truth[repr(ast.literal_eval(pats + "]"))] = ast.literal_eval("{" + res)

GROUPS = {
    "test_any_depth_or_from_the_root": [0, 1, 2, 3, 30], "test_directories_only": [4, 5], "test_negation_and_the_last_match": [6, 7, 32],
    "test_an_ignored_directory_hides_everything_in_it": [8, 9, 28, 29, 31], "test_everything_but_python": [10], "test_double_star": [11, 12, 13, 14, 25],
    "test_wildcards_and_sets": [15, 16, 17, 18], "test_escapes_comments_and_spaces": [19, 20, 21, 22, 23, 26], "test_case_sensitive": [24], "test_negating_a_directory": [27],
}
methods = []
for name, indices in GROUPS.items():
    rows = []
    for i in indices:
        patterns, paths = CASES[i]
        for path, is_dir in paths:
            expected = truth[repr(patterns)][path + ("/" if is_dir else "")]
            assert m.is_ignored(path, {"": patterns}, is_dir) == expected
            rows.append(f"            ({{'': {patterns!r}}}, {path!r}, {is_dir!r}, {expected!r}),")
    methods.append(f"    def {name}(self):\n        self.check([\n" + "\n".join(rows) + "\n        ])\n")
for name, cases in NESTED.items():
    rows = []
    for files, paths in cases:
        verdicts = probe(files, paths)
        for path, is_dir in paths:
            expected = verdicts[path + ("/" if is_dir else "")]
            assert m.is_ignored(path, files, is_dir) == expected, (files, path, expected)
            rows.append(f"            ({files!r}, {path!r}, {is_dir!r}, {expected!r}),")
    methods.append(f"    def {name}(self):\n        self.check([\n" + "\n".join(rows) + "\n        ])\n")

hidden = '''
import unittest

from ignore import is_ignored


class TestSpec(unittest.TestCase):
    """Every expectation here is what git itself decides (git check-ignore, core.ignorecase off)."""

    def check(self, cases):
        for gitignores, path, is_dir, expected in cases:
            with self.subTest(gitignores=gitignores, path=path, is_dir=is_dir):
                self.assertEqual(is_ignored(path, gitignores, is_dir), expected)

''' + "\n".join(methods) + '''

if __name__ == "__main__":
    unittest.main()
'''


SPEC = r"""
# is_ignored(path, gitignores, is_dir=False) -> bool

Whether git would ignore a path, given the repository's `.gitignore` files (and no other ignore files).
`gitignores` maps each directory that has a `.gitignore` to the file's lines: `""` is the repository's
root, and `"src"` or `"src/app"` are directories in it. `path` is relative to the root, with `/` between
its parts and no leading `/` or `./` (`src/app/main.py`). `is_dir` says whether the path itself is a
directory; its parents always are.

## Patterns

1. A blank line matches nothing, and a line starting with `#` is a comment. A backslash in front of a
   first `#` or `!` makes it literal: `\#notes` matches `#notes`, and `\!important` matches `!important`.
2. Trailing spaces are removed, unless the last of them is escaped with a backslash: `name\ ` matches
   `name ` (with the space). Spaces anywhere else are part of the pattern.
3. A pattern starting with `!` is negated: a path it matches is not ignored, even if an earlier pattern
   ignored it. When several patterns match a path, the last one decides (and see rule 12).
4. A pattern ending in `/` matches only directories: `build/` matches a directory called `build` (and so,
   by rule 9, everything in it), but not a file called `build`. The `/` is then removed for the rules
   below.
5. A pattern with a `/` at the start or in the middle is relative to the directory of its `.gitignore`:
   in the root's, `/todo` matches `todo` but not `src/todo`, and `doc/frotz` matches `doc/frotz` but not
   `a/doc/frotz`. A leading `/` is then removed. A pattern with no such `/` matches a name at any depth
   below its directory: `frotz` matches `frotz` and `a/b/frotz`.
6. `*` matches any run of characters except `/`, including none; `?` matches one character except `/`;
   and `[...]` matches one character from a set, like `[abc]` or a range `[a-z]`, or one not in it with
   `!` first, like `[!0-9]`. None of them matches `/`. A backslash makes the next character literal: `\*`
   matches `*`.
7. `**` as a whole part of a pattern (between slashes, or at either end) matches any number of
   directories: `**/foo` matches `foo` at any depth; `abc/**` matches everything inside `abc`, at any
   depth, but not `abc` itself; `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`. Anywhere else, `**` is the
   same as `*`.
8. Matching is case-sensitive.

## Which paths are ignored

9. A path is ignored if any of its parent directories is ignored. Each parent is decided like any
   directory, from the top down: for `a/b/c.txt`, first `a`, then `a/b`. So nothing inside an ignored
   directory can be brought back, not even by a negated pattern that matches it: with `logs/` and then
   `!logs/keep.txt`, `logs/keep.txt` is still ignored (`logs/*` would ignore what is in `logs` instead,
   and let the negation work).
10. A path whose parents aren't ignored is ignored if the last pattern that matches it is not negated;
    it is not ignored if that pattern is negated, or if no pattern matches it.

## Several files

11. A `.gitignore`'s patterns apply only to paths inside its directory (not to the directory itself), and
    are matched against the path relative to that directory: in `src/.gitignore`, `/out` matches
    `src/out` but not `out`, `gen/` matches a directory `gen` anywhere under `src`, and `sub/*.tmp` matches
    `src/sub/a.tmp`.
12. A deeper directory's file takes precedence: of all the patterns that match a path, from all the
    files, the last one decides when the files are read from the root down (a file in `src/app` after
    the one in `src`, after the root's) and each file from top to bottom.
13. The `.gitignore` of an ignored directory changes nothing: by rule 9, everything in that directory is
    ignored whatever it says.
"""

task(
    "gitignore-match",
    "Implement is_ignored in ignore.py so that it follows SPEC.md exactly.",
    ["python", "spec", "matching"],
    {
        "SPEC.md": SPEC,
        "ignore.py": """
            def is_ignored(path, gitignores, is_dir=False):
                "Whether git would ignore path, given the repository's .gitignore files. See SPEC.md."
                raise NotImplementedError
        """,
        "tests/test_ignore.py": """
            import unittest

            from ignore import is_ignored


            class TestBasics(unittest.TestCase):
                def test_any_depth(self):
                    self.assertTrue(is_ignored("debug.log", {"": ["*.log"]}))
                    self.assertTrue(is_ignored("logs/debug.log", {"": ["*.log"]}))
                    self.assertFalse(is_ignored("debug.txt", {"": ["*.log"]}))

                def test_negation(self):
                    self.assertFalse(is_ignored("keep.log", {"": ["*.log", "!keep.log"]}))

                def test_directory(self):
                    self.assertTrue(is_ignored("build", {"": ["build/"]}, is_dir=True))
                    self.assertFalse(is_ignored("build", {"": ["build/"]}))

                def test_a_file_in_a_directory(self):
                    self.assertTrue(is_ignored("src/out.o", {"src": ["*.o"]}))
                    self.assertFalse(is_ignored("out.o", {"src": ["*.o"]}))


            if __name__ == "__main__":
                unittest.main()
        """,
    },
    hidden,
    {"ignore.py": open("ignore_solution.py").read()},
)
