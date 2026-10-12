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
