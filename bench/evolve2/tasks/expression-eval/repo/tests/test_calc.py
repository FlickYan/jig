import unittest

from calc import EvalError, evaluate


class TestBasics(unittest.TestCase):
    def test_arithmetic(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7)
        self.assertEqual(evaluate("x / 2", {"x": 5}), 2.5)

    def test_logic(self):
        self.assertIs(evaluate("1 < x and x < 5", {"x": 2}), True)

    def test_error(self):
        with self.assertRaises(EvalError):
            evaluate("1 +")


if __name__ == "__main__":
    unittest.main()
