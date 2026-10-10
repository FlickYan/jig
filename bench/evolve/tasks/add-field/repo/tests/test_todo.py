import io
import tempfile
import unittest
from pathlib import Path

from todo.cli import main


class TestTodo(unittest.TestCase):
    def test_add_and_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Path(tmp) / "tasks.json"
            main(["add", "Buy milk"], store)
            out = io.StringIO()
            main(["list"], store, out)
            self.assertEqual(out.getvalue(), "1. [ ] Buy milk\n")


if __name__ == "__main__":
    unittest.main()
