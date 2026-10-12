import unittest

from pricing.discounts import discount
from pricing.orders import Line, Order


def order(units, unit_cents, **kwargs):
    return Order([Line("X", units, unit_cents)], **kwargs)


class BulkTest(unittest.TestCase):
    def test_tiers(self):
        self.assertEqual(discount(order(9, 1000)), 0)
        self.assertEqual(discount(order(10, 1000)), 500)  # 5%
        self.assertEqual(discount(order(50, 1000)), 4000)  # 8%
        self.assertEqual(discount(order(200, 500)), 12000)  # 12%

    def test_the_cap(self):
        self.assertEqual(discount(order(300, 1000)), 15000)  # 12% would be 360.00

    def test_rounding_half_up(self):
        self.assertEqual(discount(order(51, 1011)), 4125)  # 8% of 515.61 = 41.2488: 41.25, not cut off to 41.24
        self.assertEqual(discount(order(10, 1005)), 503)  # 5% of 100.50 = 5.025 -> 5.03

    def test_the_rest_of_2_0_stays(self):
        self.assertEqual(discount(order(50, 1000, coupon="SAVE10")), 4000 + 5000)
        self.assertEqual(discount(order(50, 1000, loyal=True)), 4000 + 1000)
        self.assertEqual(discount(order(1, 1000, loyal=True)), 20)
