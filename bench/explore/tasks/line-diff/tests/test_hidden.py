import time
import unittest

from patcher.diff import diff

TRICKY = [[['a', 'b', 'd', 'a', 'd', 'a', 'b', 'b', 'd', 'c', 'd'], ['d', 'd', 'a', 'c', 'b', 'b', 'c', 'd', 'c', 'd'], 5], [['c', 'c', 'a', 'b', 'b', 'b', 'b', 'd', 'a', 'a', 'c', 'b', 'd', 'c'], ['b', 'c', 'd', 'b'], 12], [['c', 'c', 'b', 'd', 'a', 'c', 'b', 'c', 'd', 'd', 'd', 'b', 'a'], ['b', 'a', 'c', 'c', 'a', 'b', 'd', 'd', 'a', 'd', 'a', 'a', 'd'], 10], [['b', 'a', 'a', 'd', 'd', 'a', 'a', 'd', 'b', 'a', 'b', 'd', 'd', 'a'], ['a', 'a', 'b', 'd', 'b', 'b', 'b', 'a'], 10], [['b', 'a', 'a', 'b', 'c', 'b', 'b'], ['a', 'c', 'c', 'b', 'a', 'd', 'b'], 6], [['c', 'd', 'a', 'd', 'b', 'd'], ['b', 'a', 'd', 'd', 'c', 'a', 'b', 'b', 'b', 'a', 'b', 'c', 'c', 'd'], 12]]
OTHERS = [[['c', 'b', 'b', 'd', 'c', 'c'], ['a', 'b', 'a', 'd', 'b', 'b'], 8], [['c', 'b', 'c', 'a', 'a', 'a', 'd', 'c', 'b', 'a', 'c'], ['d', 'b', 'a', 'a', 'a', 'b', 'b', 'a', 'c', 'c', 'b'], 8], [['a', 'b', 'd', 'a', 'c', 'd', 'b', 'a', 'a'], ['a', 'd', 'd', 'b', 'a', 'a'], 3], [['a', 'd'], ['d', 'd', 'c', 'a', 'a', 'd', 'c', 'b', 'b', 'a', 'a'], 9], [['c', 'd', 'a', 'b', 'b', 'b', 'a', 'b', 'b', 'd', 'b', 'a'], ['b', 'd', 'c'], 11], [['b'], ['a', 'd', 'b', 'd', 'd', 'c'], 5], [['a', 'c', 'd', 'c', 'd', 'd', 'b', 'a', 'd', 'd', 'b', 'd', 'b'], ['d', 'c', 'a', 'b', 'd', 'd', 'd', 'a', 'a', 'b', 'd', 'd', 'c', 'c'], 13], [['b', 'd', 'a', 'b', 'b', 'd', 'b', 'a', 'd'], [], 9], [['c', 'a', 'b'], ['b', 'a', 'c', 'b', 'd', 'a'], 5], [['a', 'b', 'c', 'b', 'c', 'd', 'a', 'd', 'a'], ['c', 'a', 'c', 'd', 'a', 'c', 'd', 'c', 'b', 'a', 'a'], 8], [['d', 'c', 'b', 'd', 'b'], ['b', 'a', 'a', 'a'], 7], [['c', 'c', 'c', 'a', 'b'], [], 5], [['d', 'a', 'a', 'b', 'c', 'c', 'c', 'b', 'd', 'd', 'd', 'c', 'c', 'b'], ['b', 'a', 'c', 'a', 'b', 'c', 'c', 'c', 'c', 'c', 'c', 'c', 'a', 'a'], 12], [['a', 'a', 'a', 'a', 'c', 'd', 'd'], ['c', 'a', 'b', 'a', 'd', 'd'], 5], [['d', 'b', 'c', 'a', 'b'], ['c', 'b', 'b', 'c', 'c', 'd', 'd', 'a', 'b', 'b'], 7], [['a', 'a'], ['c'], 3], [['c', 'b', 'b', 'b', 'c', 'b', 'b', 'c', 'a', 'd', 'a', 'a', 'a', 'a'], ['c', 'b', 'a', 'b', 'c', 'c', 'b', 'a', 'b', 'c', 'a', 'b'], 10], [['a', 'b', 'd', 'b', 'b', 'c', 'd', 'b', 'c', 'a', 'c'], ['d', 'd', 'c', 'd', 'd', 'c', 'd', 'c'], 9], [['a', 'a'], ['b', 'c', 'd', 'd', 'd', 'b', 'd'], 9], [['c', 'b', 'a', 'c', 'a', 'a', 'c', 'c', 'c', 'b', 'c', 'b', 'a'], ['d', 'd', 'a', 'd', 'b', 'a', 'd', 'b'], 15]]


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
        old = ["}" if i % 3 == 0 else ("" if i % 3 == 1 else f"    value_{i % 97} += 1") for i in range(50000)]
        new = list(old)
        for i in range(10, 50000, 1000):
            new[i] = f"    changed_{i}()"
        started = time.perf_counter()
        ops = diff(old, new)
        self.assertLess(time.perf_counter() - started, 2)
        self.assertEqual(rebuilt(ops), (old, new))
        self.assertEqual(edits(ops), 100)
