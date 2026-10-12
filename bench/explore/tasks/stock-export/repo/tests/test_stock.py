import contextlib
import io
import os
import tempfile
import unittest

from stock.cli import main


class StockTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = os.getcwd()
        os.chdir(self.dir.name)

    def tearDown(self):
        os.chdir(self.old)
        self.dir.cleanup()

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(list(argv))
        return code, out.getvalue()

    def test_add_and_list(self):
        self.run_cli("add", "M1", "Mug", "3", "7.50")
        code, out = self.run_cli("list")
        self.assertEqual(code, 0)
        self.assertIn("Mug", out)
        self.assertIn("7.50", out)
