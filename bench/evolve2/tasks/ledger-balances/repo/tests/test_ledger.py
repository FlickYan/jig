import unittest
from decimal import Decimal

from ledger import balances


class TestBasics(unittest.TestCase):
    def test_one_transaction(self):
        journal = "2024-01-01 Coffee\n    expenses:coffee  $3.50\n    assets:cash\n"
        self.assertEqual(balances(journal), {
            "expenses": {"$": Decimal("3.50")}, "expenses:coffee": {"$": Decimal("3.50")},
            "assets": {"$": Decimal("-3.50")}, "assets:cash": {"$": Decimal("-3.50")},
        })

    def test_unbalanced(self):
        with self.assertRaises(ValueError):
            balances("2024-01-01 Oops\n    a  $1\n    b  $2\n")


if __name__ == "__main__":
    unittest.main()
