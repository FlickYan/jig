"""line-diff: the visible test is five lines; the spec asks for the shortest diff of 50,000-line files.

What the agent must do beyond its first check: the project's own test diffs two short files, which any
diff gets right. SPEC.md asks for the fewest deletions and additions, on files of up to 50,000 lines, in
2 seconds. difflib is quick but doesn't promise the fewest (and on files with many repeated lines, such as
blank lines and closing braces, it gives up on matching altogether); a table over every pair of lines is
exact but far too slow. The hidden tests check both, against the shortest edit counted independently.
"""
import difflib
import random

from maketask import task

REFERENCE = '''
def diff(old, new):
    """How to turn old into new, as ("keep" | "del" | "add", line) in order, with as few deletions and
    additions as possible: Myers' algorithm, in O((N + M) D) time for D differences."""
    n, m = len(old), len(new)
    offset = n + m + 1
    v = [0] * (2 * offset + 1)  # v[k]: the furthest x reached on diagonal k = x - y
    history = []  # v before each round d, to walk the path back
    for d in range(n + m + 1):
        history.append(v[:])
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1]):
                x = v[offset + k + 1]  # down: a line added
            else:
                x = v[offset + k - 1] + 1  # right: a line deleted
            y = x - k
            while x < n and y < m and old[x] == new[y]:
                x, y = x + 1, y + 1
            v[offset + k] = x
            if x >= n and y >= m:
                return _path(old, new, history, offset, d)
    raise AssertionError("unreachable: n + m rounds always reach the end")


def _path(old, new, history, offset, rounds):
    ops = []
    x, y = len(old), len(new)
    for d in range(rounds, 0, -1):
        v = history[d]
        k = x - y
        added = k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1])
        start_x = v[offset + k + 1] if added else v[offset + k - 1]
        start_y = start_x - (k + 1 if added else k - 1)
        mid_x = start_x if added else start_x + 1  # where the edit ends and the run of kept lines starts
        while x > mid_x:
            x, y = x - 1, y - 1
            ops.append(("keep", old[x]))
        if added:
            ops.append(("add", new[start_y]))
        else:
            ops.append(("del", old[start_x]))
        x, y = start_x, start_y
    while x > 0:
        x, y = x - 1, y - 1
        ops.append(("keep", old[x]))
    ops.reverse()
    return ops
'''

namespace = {}
exec(REFERENCE, namespace)
reference = namespace["diff"]


def shortest(old, new):
    """The fewest deletions and additions, from the longest common subsequence (for short inputs)."""
    previous = [0] * (len(new) + 1)
    for a in old:
        current = [0]
        for j, b in enumerate(new):
            current.append(previous[j] + 1 if a == b else max(previous[j + 1], current[j]))
        previous = current
    return len(old) + len(new) - 2 * previous[-1]


def rebuilt(ops):
    return [l for op, l in ops if op != "add"], [l for op, l in ops if op != "del"]


# Short cases where difflib's matching isn't the shortest, found by a seeded search, plus random others.
rng = random.Random(41)
TRICKY, OTHERS = [], []
while len(TRICKY) < 6 or len(OTHERS) < 20:
    old = [rng.choice("abcd") for _ in range(rng.randint(0, 14))]
    new = [rng.choice("abcd") for _ in range(rng.randint(0, 14))]
    best = shortest(old, new)
    ops = reference(old, new)
    assert rebuilt(ops) == (old, new) and sum(op != "keep" for op, _ in ops) == best
    kept = sum(size for _, _, size in difflib.SequenceMatcher(None, old, new, autojunk=False).get_matching_blocks())
    if len(old) + len(new) - 2 * kept > best and len(TRICKY) < 6:
        TRICKY.append([old, new, best])
    elif len(OTHERS) < 20:
        OTHERS.append([old, new, best])

FILES = {
    "README.md": """
        # patcher

        Shows what changed between two versions of a file. The diff it needs is specified in SPEC.md.
        """,
    "SPEC.md": """
        # diff(old, new)

        `old` and `new` are lists of lines (strings). `diff` returns how to turn `old` into `new`: a list of
        operations, in order, each one of

        - `("keep", line)`: the line is in both,
        - `("del", line)`: the line is only in `old`,
        - `("add", line)`: the line is only in `new`.

        Reading the "keep" and "del" lines in order gives `old`; reading the "keep" and "add" lines gives `new`.

        - The list has as few "del" and "add" operations as possible: no shorter list turns `old` into `new`.
        - Files have up to 50,000 lines. When `old` and `new` differ in at most 200 lines, `diff` answers
          within 2 seconds.
        """,
    "patcher/__init__.py": "",
    "patcher/diff.py": '''
        def diff(old, new):
            """How to turn old into new, as ("keep" | "del" | "add", line) operations. See SPEC.md."""
            raise NotImplementedError
        ''',
    "patcher/show.py": '''
        from patcher.diff import diff


        def show(old_text, new_text):
            """The change as lines starting with "  ", "- " or "+ ", as the review page prints it."""
            marks = {"keep": "  ", "del": "- ", "add": "+ "}
            return "\\n".join(marks[op] + line for op, line in diff(old_text.splitlines(), new_text.splitlines()))
        ''',
    "tests/__init__.py": "",
    "tests/test_diff.py": """
        import unittest

        from patcher.diff import diff


        class DiffTest(unittest.TestCase):
            def test_a_small_change(self):
                old = ["a", "b", "c", "d", "e"]
                new = ["a", "c", "d", "x", "e"]
                ops = diff(old, new)
                self.assertEqual([l for op, l in ops if op != "add"], old)
                self.assertEqual([l for op, l in ops if op != "del"], new)
                self.assertEqual(sum(op != "keep" for op, _ in ops), 2)
        """,
}

HIDDEN = f'''
    import time
    import unittest

    from patcher.diff import diff

    TRICKY = {TRICKY!r}
    OTHERS = {OTHERS!r}


    def rebuilt(ops):
        return [l for op, l in ops if op != "add"], [l for op, l in ops if op != "del"]


    def edits(ops):
        return sum(op != "keep" for op, _ in ops)


    class DiffTest(unittest.TestCase):
        def test_the_shortest_diff(self):
            for old, new, best in TRICKY + OTHERS:
                with self.subTest(old=old, new=new):
                    ops = diff(old, new)
                    self.assertEqual(rebuilt(ops), (old, new))
                    self.assertEqual(edits(ops), best)

        def test_edges(self):
            for old, new, best in (([], [], 0), ([], ["a"], 1), (["a", "b"], [], 2), (["a", "b"], ["a", "b"], 0), (["a"], ["b"], 2)):
                ops = diff(old, new)
                self.assertEqual((rebuilt(ops), edits(ops)), ((old, new), best))

        def test_long_files_with_repeated_lines(self):
            # Closing braces and blank lines, as in real code: many equal lines.
            old = ["}}" if i % 3 == 0 else ("" if i % 3 == 1 else f"    value_{{i % 97}} += 1") for i in range(50000)]
            new = list(old)
            for i in range(10, 50000, 1000):
                new[i] = f"    changed_{{i}}()"
            started = time.perf_counter()
            ops = diff(old, new)
            self.assertLess(time.perf_counter() - started, 2)
            self.assertEqual(rebuilt(ops), (old, new))
            self.assertEqual(edits(ops), 100)
'''

task(
    "line-diff",
    "Implement diff in patcher/diff.py so that it follows SPEC.md.",
    ["python", "spec", "algorithms", "generalization"],
    FILES,
    HIDDEN,
    {"patcher/diff.py": REFERENCE},
)
