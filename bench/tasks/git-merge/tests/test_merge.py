import subprocess
import sys
import unittest


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True)


class MergeTest(unittest.TestCase):
    def test_on_main_with_a_merge_commit(self):
        self.assertEqual(git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip(), "main")
        parents = git("rev-list", "--parents", "-n", "1", "HEAD").stdout.split()
        self.assertEqual(len(parents), 3, "HEAD should be a merge commit with two parents")
        self.assertEqual(git("merge-base", "--is-ancestor", "feature", "HEAD").returncode, 0)

    def test_merge_is_committed_and_resolved(self):
        with open("app.py") as f:
            text = f.read()
        for marker in ("<<<<<<<", "=======", ">>>>>>>"):
            self.assertNotIn(marker, text)
        self.assertEqual(git("diff", "--quiet", "HEAD", "--", "app.py").returncode, 0, "app.py has uncommitted changes")

    def test_both_changes_are_kept(self):
        result = subprocess.run([sys.executable, "app.py", "Ada"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Hi Ada, welcome back!\n")
        self.assertIn("INFO greeting Ada", result.stderr)


if __name__ == "__main__":
    unittest.main()
