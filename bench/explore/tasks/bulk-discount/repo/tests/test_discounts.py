import unittest

from pricing.discounts import discount
from pricing.orders import Line, Order


class DiscountTest(unittest.TestCase):
    def test_coupon(self):
        self.assertEqual(discount(Order([Line("M", 2, 1000)], coupon="SAVE10")), 200)

    def test_loyalty(self):
        self.assertEqual(discount(Order([Line("M", 1, 1000)], loyal=True)), 20)
