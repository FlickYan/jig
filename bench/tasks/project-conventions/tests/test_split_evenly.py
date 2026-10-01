import ast
import inspect
import re
import unittest

from billing import split
from billing.split import split_evenly


class SplitEvenlyTest(unittest.TestCase):
    def test_shares(self):
        self.assertEqual(split_evenly(1000, 3), [334, 333, 333])
        self.assertEqual(split_evenly(1001, 4), [251, 250, 250, 250])
        self.assertEqual(split_evenly(2, 4), [1, 1, 0, 0])
        self.assertEqual(split_evenly(5, 1), [5])
        for total, people in [(0, 3), (99_999, 7), (10, 10)]:
            shares = split_evenly(total, people)
            self.assertEqual(sum(shares), total)
            self.assertLessEqual(max(shares) - min(shares), 1)
            self.assertTrue(all(type(share) is int for share in shares))

    def test_people_must_be_at_least_one(self):
        with self.assertRaises(ValueError):
            split_evenly(100, 0)


class ProjectConventionsTest(unittest.TestCase):
    """The rules in AGENTS.md."""

    def test_no_floats(self):
        for node in ast.walk(ast.parse(inspect.getsource(split_evenly))):
            self.assertNotIsInstance(getattr(node, "op", None), ast.Div, "true division makes floats")
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "float":
                self.fail("float() used")

    def test_type_hints_docstring_and_all(self):
        self.assertTrue({"total_cents", "people", "return"} <= set(split_evenly.__annotations__))
        self.assertTrue((split_evenly.__doc__ or "").strip())
        self.assertIn("split_evenly", split.__all__)

    def test_changelog(self):
        with open("CHANGELOG.md") as f:
            unreleased = f.read().split("## Unreleased", 1)[1].split("\n## ", 1)[0]
        self.assertTrue(re.search(r"^- .*split_evenly", unreleased, re.MULTILINE), "no entry under Unreleased")


if __name__ == "__main__":
    unittest.main()
