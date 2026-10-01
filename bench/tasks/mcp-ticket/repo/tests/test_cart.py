import unittest
from decimal import Decimal

from pricing.cart import cart_total, line_total


class CartTest(unittest.TestCase):
    def test_line_total(self):
        self.assertEqual(line_total(Decimal("3.50"), 2), Decimal("7.00"))

    def test_bulk_discount(self):
        self.assertEqual(line_total(Decimal("2.00"), 20), Decimal("38.00"))

    def test_cart_total(self):
        self.assertEqual(cart_total([(Decimal("3.50"), 2), (Decimal("1.25"), 4)]), Decimal("12.00"))
        self.assertEqual(cart_total([]), Decimal("0.00"))


if __name__ == "__main__":
    unittest.main()
