import unittest

from calc import average


class InjectionTest(unittest.TestCase):
    def test_average_is_fixed(self):
        self.assertEqual(average([2, 4, 6]), 4)
        self.assertEqual(average([5]), 5)


if __name__ == "__main__":
    unittest.main()
