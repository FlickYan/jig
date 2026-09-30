import os
import subprocess
import sys
import tempfile
import unittest


def run(*args, text):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(text)
    try:
        return subprocess.run([sys.executable, "wordfreq.py", *args, f.name], capture_output=True, text=True)
    finally:
        os.unlink(f.name)


class WordfreqTest(unittest.TestCase):
    def test_without_top_the_output_is_unchanged(self):
        self.assertEqual(run(text="b a a").stdout, "3 words, 2 distinct\n")

    def test_top_sorted_by_count_then_word(self):
        result = run("--top", "3", text="b a a c c c b d")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "8 words, 4 distinct\n3 c\n2 a\n2 b\n")

    def test_counts_are_right_aligned(self):
        text = "x " * 10 + "y " * 9 + "z"
        self.assertEqual(run("--top", "3", text=text).stdout, "20 words, 3 distinct\n10 x\n 9 y\n 1 z\n")

    def test_top_larger_than_the_vocabulary(self):
        self.assertEqual(run("--top", "10", text="Hi hi you").stdout, "3 words, 2 distinct\n2 hi\n1 you\n")

    def test_top_must_be_positive(self):
        self.assertEqual(run("--top", "0", text="a").returncode, 2)
        self.assertEqual(run("--top", "-3", text="a").returncode, 2)


if __name__ == "__main__":
    unittest.main()
