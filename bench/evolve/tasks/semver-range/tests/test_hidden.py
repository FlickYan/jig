import unittest

from semver_range import satisfies


class TestSpec(unittest.TestCase):
    def test_versions(self):
        self.assertTrue(satisfies("v1.2.3", "1.2.3"))
        self.assertTrue(satisfies("1.2.3+build.5", "1.2.3"))
        for bad in ["1.2", "01.2.3", "1.2.3.4", "a.b.c", "1.2.3-", "1.2.3-be$ta"]:
            with self.assertRaises(ValueError, msg=bad):
                satisfies(bad, "*")

    def test_prerelease_precedence(self):
        order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
        for lower, higher in zip(order, order[1:]):
            self.assertTrue(satisfies(higher, f">{lower}"), f"{higher} > {lower}")
            self.assertFalse(satisfies(lower, f">={higher}"), f"{lower} < {higher}")

    def test_or_and_and(self):
        self.assertTrue(satisfies("3.1.0", "<2.0.0 || >=3.0.0"))
        self.assertFalse(satisfies("2.5.0", "<2.0.0 || >=3.0.0"))
        self.assertTrue(satisfies("1.2.3", "=1.2.3"))
        self.assertFalse(satisfies("1.2.4", "1.2.3"))

    def test_caret(self):
        self.assertFalse(satisfies("2.0.0", "^1.2.3"))
        self.assertTrue(satisfies("0.2.9", "^0.2.3"))
        self.assertFalse(satisfies("0.3.0", "^0.2.3"))
        self.assertTrue(satisfies("0.0.3", "^0.0.3"))
        self.assertFalse(satisfies("0.0.4", "^0.0.3"))

    def test_tilde(self):
        self.assertTrue(satisfies("1.2.9", "~1.2.3"))
        self.assertFalse(satisfies("1.3.0", "~1.2.3"))
        self.assertTrue(satisfies("1.2.0", "~1.2"))
        self.assertTrue(satisfies("1.9.9", "~1"))
        self.assertFalse(satisfies("2.0.0", "~1"))

    def test_x_ranges(self):
        self.assertTrue(satisfies("5.4.3", "*"))
        self.assertTrue(satisfies("5.4.3", ""))
        self.assertTrue(satisfies("1.7.0", "1.x"))
        self.assertTrue(satisfies("1.7.0", "1.*"))
        self.assertTrue(satisfies("1.7.0", "1"))
        self.assertFalse(satisfies("2.0.0", "1.x"))
        self.assertTrue(satisfies("1.2.7", "1.2.x"))
        self.assertTrue(satisfies("1.2.7", "1.2"))
        self.assertFalse(satisfies("1.3.0", "1.2.x"))

    def test_prerelease_rule(self):
        self.assertTrue(satisfies("1.2.3-beta.2", ">=1.2.3-beta.1 <1.3.0"))
        self.assertFalse(satisfies("1.3.0-beta", ">=1.2.0"))
        self.assertFalse(satisfies("1.2.3-beta", "*"))
        self.assertFalse(satisfies("1.2.3-beta", "^1.2.0"))
        self.assertTrue(satisfies("1.2.3-beta", "1.2.3-beta"))
        self.assertFalse(satisfies("1.2.4-beta", ">=1.2.3-beta.1 <1.3.0"))

    def test_bad_ranges(self):
        for bad in [">=", "^", ">=1.2.3 <", "1.2.3 ||| 2.0.0", "=>1.2.3"]:
            with self.assertRaises(ValueError, msg=bad):
                satisfies("1.2.3", bad)


if __name__ == "__main__":
    unittest.main()
