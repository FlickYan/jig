import unittest

from toml_lite import TOMLError, loads


class TestBasics(unittest.TestCase):
    def test_pairs_and_tables(self):
        self.assertEqual(loads('title = "x"\n[owner]\nname = "Ada"\n'), {"title": "x", "owner": {"name": "Ada"}})

    def test_numbers(self):
        self.assertEqual(loads("a = 1\nb = 2.5\n"), {"a": 1, "b": 2.5})

    def test_duplicate_key(self):
        with self.assertRaises(TOMLError):
            loads("a = 1\na = 2\n")


if __name__ == "__main__":
    unittest.main()
