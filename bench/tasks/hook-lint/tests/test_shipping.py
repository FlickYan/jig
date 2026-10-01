import unittest
from decimal import Decimal
from pathlib import Path

from shop.shipping import shipping_cost

import project_lint


class ShippingCostTest(unittest.TestCase):
    def test_every_started_kilogram(self):
        self.assertEqual(shipping_cost(2.1, Decimal("20.00")), Decimal("7.54"))
        self.assertEqual(shipping_cost(1, Decimal("74.99")), Decimal("5.84"))
        self.assertEqual(shipping_cost(30, Decimal("10.00")), Decimal("30.49"))

    def test_free_from_75(self):
        self.assertEqual(shipping_cost(5, Decimal("75.00")), Decimal("0"))
        self.assertEqual(shipping_cost(12.5, Decimal("120.00")), Decimal("0"))

    def test_too_heavy(self):
        with self.assertRaises(ValueError):
            shipping_cost(30.5, Decimal("10.00"))

    def test_returns_decimal(self):
        self.assertIsInstance(shipping_cost(2, Decimal("10.00")), Decimal)


class LintTest(unittest.TestCase):
    """The team linter the hook runs passes on every module (checked with a copy of it)."""

    def test_no_magic_numbers(self):
        found = [f"{path.name}:{line}: {message}" for path in sorted(Path("shop").glob("*.py")) for line, message in project_lint.problems(path)]
        self.assertEqual(found, [])


if __name__ == "__main__":
    unittest.main()
