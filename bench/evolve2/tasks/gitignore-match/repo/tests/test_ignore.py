import unittest

from ignore import is_ignored


class TestBasics(unittest.TestCase):
    def test_any_depth(self):
        self.assertTrue(is_ignored("debug.log", {"": ["*.log"]}))
        self.assertTrue(is_ignored("logs/debug.log", {"": ["*.log"]}))
        self.assertFalse(is_ignored("debug.txt", {"": ["*.log"]}))

    def test_negation(self):
        self.assertFalse(is_ignored("keep.log", {"": ["*.log", "!keep.log"]}))

    def test_directory(self):
        self.assertTrue(is_ignored("build", {"": ["build/"]}, is_dir=True))
        self.assertFalse(is_ignored("build", {"": ["build/"]}))

    def test_a_file_in_a_directory(self):
        self.assertTrue(is_ignored("src/out.o", {"src": ["*.o"]}))
        self.assertFalse(is_ignored("out.o", {"src": ["*.o"]}))


if __name__ == "__main__":
    unittest.main()
