import unittest

from roman import from_roman, to_roman


class TestBasics(unittest.TestCase):
    def test_to_roman(self):
        self.assertEqual(to_roman(1994), "MCMXCIV")
        self.assertEqual(to_roman(4), "IV")

    def test_from_roman(self):
        self.assertEqual(from_roman("MCMXCIV"), 1994)


if __name__ == "__main__":
    unittest.main()
