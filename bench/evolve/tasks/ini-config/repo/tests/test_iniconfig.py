import unittest

from iniconfig import parse


class TestBasics(unittest.TestCase):
    def test_sections_and_keys(self):
        self.assertEqual(parse("[server]\nhost = example.org\nport: 8080\n"), {"server": {"host": "example.org", "port": "8080"}})

    def test_comments(self):
        self.assertEqual(parse("# a comment\n[a]\nx = 1\n"), {"a": {"x": "1"}})


if __name__ == "__main__":
    unittest.main()
