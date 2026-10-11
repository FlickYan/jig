import unittest

from words import from_words, to_ordinal, to_words


class TestBasics(unittest.TestCase):
    def test_words(self):
        self.assertEqual(to_words(42), "forty-two")
        self.assertEqual(to_words(305), "three hundred five")

    def test_ordinal(self):
        self.assertEqual(to_ordinal(3), "third")

    def test_reading(self):
        self.assertEqual(from_words("one hundred one"), 101)


if __name__ == "__main__":
    unittest.main()
