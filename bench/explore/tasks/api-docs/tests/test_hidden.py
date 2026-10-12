import os
import subprocess
import sys
import unittest
from datetime import date

from ledger.balances import balance_on
from ledger.entries import entry

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class BalanceOnTest(unittest.TestCase):
    def test_balance_at_the_end_of_a_day(self):
        entries = [entry("cash", 500, date(2026, 1, 1)), entry("cash", -200, date(2026, 1, 2)), entry("cash", 50, date(2026, 1, 2)), entry("cash", 1000, date(2026, 1, 5))]
        self.assertEqual(balance_on(entries, date(2025, 12, 31)), 0)
        self.assertEqual(balance_on(entries, date(2026, 1, 2)), 350)
        self.assertEqual(balance_on(entries, date(2026, 1, 9)), 1350)

    def test_the_reference_is_what_the_generator_writes(self):
        generated = subprocess.run([sys.executable, "tools/gen_api.py", "ledger"], cwd=HERE, capture_output=True, text=True, check=True).stdout
        with open(os.path.join(HERE, "docs", "api.md")) as f:
            self.assertEqual(f.read(), generated)
        self.assertIn("balance_on", generated)
