import unittest

from buildorder import CycleError, build_order


class TestBasics(unittest.TestCase):
    def test_order(self):
        self.assertEqual(build_order({"app": ["lib"], "lib": []}), ["lib", "app"])

    def test_cycle(self):
        with self.assertRaises(CycleError):
            build_order({"a": ["b"], "b": ["a"]})


if __name__ == "__main__":
    unittest.main()
