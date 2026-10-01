import unittest
from decimal import Decimal

from pricing.cart import cart_total, line_total


class Price118Test(unittest.TestCase):
    """The pricing policy in ticket PRICE-118."""

    def test_bulk_discount_from_ten_items(self):
        self.assertEqual(line_total(Decimal("2.00"), 10), Decimal("19.00"))
        self.assertEqual(line_total(Decimal("2.00"), 9), Decimal("18.00"))
        self.assertEqual(line_total(Decimal("2.00"), 20), Decimal("38.00"))

    def test_coupon_comes_off_the_discounted_total(self):
        self.assertEqual(cart_total([(Decimal("2.00"), 10)], coupon_percent=10), Decimal("17.10"))
        self.assertEqual(cart_total([(Decimal("2.00"), 10), (Decimal("5.00"), 1)], coupon_percent=20), Decimal("19.20"))

    def test_halves_round_up(self):
        self.assertEqual(cart_total([(Decimal("0.25"), 1)], coupon_percent=50), Decimal("0.13"))
        self.assertEqual(cart_total([(Decimal("1.005"), 1)]), Decimal("1.01"))

    def test_unchanged_behaviour(self):
        self.assertEqual(cart_total([(Decimal("3.50"), 2), (Decimal("1.25"), 4)]), Decimal("12.00"))
        self.assertEqual(cart_total([]), Decimal("0.00"))


if __name__ == "__main__":
    unittest.main()
