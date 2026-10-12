import contextlib
import datetime
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from stock.cli import main


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.dir.name)
        with open("stock.ini", "w") as f:
            f.write("[export]\ndirectory = out/files\n\n[money]\ncurrency = GBP\n")
        self.today = mock.patch("stock.clock.today", return_value=datetime.date(2026, 3, 9))
        self.today.start()
        for argv in (["add", "T9", "Tea, green", "4", "3.20"], ["add", "A1", "Apron", "2", "12"]):
            self.run_cli(*argv)

    def tearDown(self):
        self.today.stop()
        os.chdir(self.old)
        self.dir.cleanup()

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(argv))
        return code, out.getvalue()

    def test_writes_the_file_where_and_as_the_project_writes_files(self):
        code, out = self.run_cli("export")
        self.assertEqual(code, 0)
        path = os.path.join("out/files", "export-20260309.csv")
        self.assertTrue(os.path.exists(path), os.listdir("."))
        with open(path) as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], "# currency: GBP")
        self.assertEqual(lines[2:], ["A1,Apron,2,1200", 'T9,"Tea, green",4,320'])

    def test_prints_the_path_the_way_commands_print(self):
        path = os.path.join("out/files", "export-20260309.csv")
        self.assertEqual(self.run_cli("export"), (0, f"path: {path}\n"))
        code, out = self.run_cli("--json", "export")
        self.assertEqual((code, json.loads(out)), (0, {"path": path}))

    def test_is_a_command_like_the_others(self):
        from stock.commands import COMMANDS
        self.assertIn("export", COMMANDS)
        self.assertTrue(COMMANDS["export"].__doc__)
