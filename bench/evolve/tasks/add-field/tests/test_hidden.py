import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from todo.cli import main
from todo.model import Task
from todo.storage import load, save

ROOT = Path(__file__).resolve().parent.parent


class TestPriority(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Path(self.tmp.name) / "tasks.json"

    def tearDown(self):
        self.tmp.cleanup()

    def listing(self):
        out = io.StringIO()
        main(["list"], self.store, out)
        return out.getvalue()

    def test_model(self):
        self.assertEqual(Task("x").priority, "normal")
        self.assertEqual(Task("x", priority="high").priority, "high")
        with self.assertRaises(ValueError):
            Task("x", priority="urgent")

    def test_saved_and_old_files_load_as_normal(self):
        save([Task("a", priority="low")], self.store)
        self.assertEqual(load(self.store)[0].priority, "low")
        self.store.write_text(json.dumps([{"title": "old", "done": False}]))
        self.assertEqual(load(self.store)[0].priority, "normal")

    def test_cli(self):
        main(["add", "Buy milk", "--priority", "high"], self.store)
        main(["add", "Walk"], self.store)
        main(["add", "Read", "--priority", "low"], self.store)
        main(["done", "2"], self.store)
        self.assertEqual(self.listing(), "1. [ ] [high] Buy milk\n2. [x] Walk\n3. [ ] [low] Read\n")
        with self.assertRaises(SystemExit):
            main(["add", "x", "--priority", "urgent"], self.store)

    def test_export(self):
        main(["add", "Buy milk", "--priority", "high"], self.store)
        main(["add", "Walk"], self.store)
        target = Path(self.tmp.name) / "out.csv"
        main(["export", str(target)], self.store)
        rows = list(csv.reader(target.read_text().splitlines()))
        self.assertEqual(rows, [["title", "priority", "done"], ["Buy milk", "high", "no"], ["Walk", "normal", "no"]])

    def test_docs(self):
        text = (ROOT / "docs" / "USAGE.md").read_text()
        self.assertIn("--priority", text)
        for word in ["low", "normal", "high"]:
            self.assertIn(word, text)


if __name__ == "__main__":
    unittest.main()
