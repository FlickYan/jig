import unittest

from shop.order import Order


class TestOrders(unittest.TestCase):
    def test_receipt(self):
        order = Order([("tea", 2), ("mug", 1)])
        self.assertEqual(order.receipt(), "tea x2  $39.98\nmug x1  $7.50\nSubtotal  $47.48\nTax  $3.92\nTotal  $51.40")

    def test_discount_code(self):
        order = Order([("kettle", 1)], "SAVE10")
        self.assertEqual(order.receipt().splitlines()[-3:], ["Discount SAVE10  -$4.00", "Tax  $2.97", "Total  $38.92"])

    def test_unknown_code(self):
        with self.assertRaises(ValueError):
            Order([("tea", 1)], "FREE")


if __name__ == "__main__":
    unittest.main()
