import unittest

from urlpath import normalize


class TestBasics(unittest.TestCase):
    def test_dot_segments(self):
        self.assertEqual(normalize("/a/b/../c/./d"), "/a/c/d")

    def test_slashes(self):
        self.assertEqual(normalize("//a///b"), "/a/b")


if __name__ == "__main__":
    unittest.main()
