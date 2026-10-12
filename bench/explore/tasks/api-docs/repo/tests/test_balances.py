import unittest
from datetime import date

from ledger.balances import balance
from ledger.entries import entry


class BalanceTest(unittest.TestCase):
    def test_balance(self):
        self.assertEqual(balance([entry("cash", 500, date(2026, 1, 1)), entry("cash", -200, date(2026, 1, 2))]), 300)
