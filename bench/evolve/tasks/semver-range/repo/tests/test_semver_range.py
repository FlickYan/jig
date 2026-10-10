import unittest

from semver_range import satisfies


class TestBasics(unittest.TestCase):
    def test_exact_and_comparators(self):
        self.assertTrue(satisfies("1.2.3", "1.2.3"))
        self.assertTrue(satisfies("1.5.0", ">=1.2.0 <2.0.0"))
        self.assertFalse(satisfies("2.0.0", ">=1.2.0 <2.0.0"))

    def test_caret(self):
        self.assertTrue(satisfies("1.9.0", "^1.2.3"))


if __name__ == "__main__":
    unittest.main()
