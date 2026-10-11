import unittest

from shop.catalog import price
from shop.money import dollars
from shop.order import Order

CASES = [([('tea', 1)], 'HALF', 'tea x1  $19.99\nSubtotal  $19.99\nDiscount HALF  -$10.00\nTax  $0.82\nShipping  $4.99\nTotal  $15.80', 1999, 1000, 82, 499, 1580), ([('cups', 3)], None, 'cups x3  $6.00\nSubtotal  $6.00\nTax  $0.50\nShipping  $4.99\nTotal  $11.49', 600, 0, 50, 499, 1149), ([('honey', 1)], 'HALF', 'honey x1  $4.25\nSubtotal  $4.25\nDiscount HALF  -$2.13\nTax  $0.17\nShipping  $4.99\nTotal  $7.28', 425, 213, 17, 499, 728), ([('mug', 1)], 'SAVE15', 'mug x1  $7.50\nSubtotal  $7.50\nTax  $0.62\nShipping  $4.99\nTotal  $13.11', 750, 0, 62, 499, 1311), ([('spoon', 1)], 'SAVE15', 'spoon x1  $0.10\nSubtotal  $0.10\nTax  $0.01\nShipping  $4.99\nTotal  $5.10', 10, 0, 1, 499, 510), ([('spoon', 3)], 'SAVE15', 'spoon x3  $0.30\nSubtotal  $0.30\nTax  $0.02\nShipping  $4.99\nTotal  $5.31', 30, 0, 2, 499, 531), ([('kettle', 2)], 'SAVE15', 'kettle x2  $79.90\nSubtotal  $79.90\nDiscount SAVE15  -$11.99\nTax  $5.60\nTotal  $73.51', 7990, 1199, 560, 0, 7351), ([('tea', 3), ('jam', 7)], 'SAVE10', 'tea x3  $39.98\njam x7  $23.45\nSubtotal  $63.43\nDiscount SAVE10  -$6.34\nTax  $4.71\nTotal  $61.80', 6343, 634, 471, 0, 6180), ([('cups', 6)], 'HALF', 'cups x6  $12.00\nSubtotal  $12.00\nDiscount HALF  -$6.00\nTax  $0.50\nShipping  $4.99\nTotal  $11.49', 1200, 600, 50, 499, 1149), ([('honey', 3), ('spoon', 2)], None, 'honey x3  $12.75\nspoon x2  $0.20\nSubtotal  $12.95\nTax  $1.07\nShipping  $4.99\nTotal  $19.01', 1295, 0, 107, 499, 1901), ([('jam', 1)], None, 'jam x1  $3.35\nSubtotal  $3.35\nTax  $0.28\nShipping  $4.99\nTotal  $8.62', 335, 0, 28, 499, 862), ([('tea', 2), ('mug', 1)], None, 'tea x2  $39.98\nmug x1  $7.50\nSubtotal  $47.48\nTax  $3.92\nTotal  $51.40', 4748, 0, 392, 0, 5140), ([('tea', 3)], None, 'tea x3  $39.98\nSubtotal  $39.98\nTax  $3.30\nTotal  $43.28', 3998, 0, 330, 0, 4328), ([('tea', 5)], 'SAVE10', 'tea x5  $79.96\nSubtotal  $79.96\nDiscount SAVE10  -$8.00\nTax  $5.94\nTotal  $77.90', 7996, 800, 594, 0, 7790), ([('tea', 6), ('spoon', 1)], None, 'tea x6  $79.96\nspoon x1  $0.10\nSubtotal  $80.06\nTax  $6.60\nTotal  $86.66', 8006, 0, 660, 0, 8666), ([('tea', 1), ('mug', 1), ('tea', 2)], None, 'tea x3  $39.98\nmug x1  $7.50\nSubtotal  $47.48\nTax  $3.92\nTotal  $51.40', 4748, 0, 392, 0, 5140), ([('kettle', 1), ('honey', 3)], 'SAVE15', 'kettle x1  $39.95\nhoney x3  $12.75\nSubtotal  $52.70\nDiscount SAVE15  -$7.91\nTax  $3.70\nTotal  $48.49', 5270, 791, 370, 0, 4849), ([('kettle', 1), ('cups', 5)], 'SAVE15', 'kettle x1  $39.95\ncups x5  $10.00\nSubtotal  $49.95\nTax  $4.12\nTotal  $54.07', 4995, 0, 412, 0, 5407), ([('tea', 3), ('jam', 3)], 'SAVE15', 'tea x3  $39.98\njam x3  $10.05\nSubtotal  $50.03\nDiscount SAVE15  -$7.50\nTax  $3.51\nTotal  $46.04', 5003, 750, 351, 0, 4604), ([('mug', 4), ('cups', 2), ('spoon', 9), ('jam', 1)], None, 'mug x4  $30.00\ncups x2  $4.00\nspoon x9  $0.90\njam x1  $3.35\nSubtotal  $38.25\nTax  $3.16\nTotal  $41.41', 3825, 0, 316, 0, 4141), ([('mug', 4), ('cups', 2), ('spoon', 10)], None, 'mug x4  $30.00\ncups x2  $4.00\nspoon x10  $1.00\nSubtotal  $35.00\nTax  $2.89\nTotal  $37.89', 3500, 0, 289, 0, 3789), ([('kettle', 2)], 'HALF', 'kettle x2  $79.90\nSubtotal  $79.90\nDiscount HALF  -$39.95\nTax  $3.30\nTotal  $43.25', 7990, 3995, 330, 0, 4325), ([('mug', 4)], 'HALF', 'mug x4  $30.00\nSubtotal  $30.00\nDiscount HALF  -$15.00\nTax  $1.24\nShipping  $4.99\nTotal  $21.23', 3000, 1500, 124, 499, 2123)]


class TestCents(unittest.TestCase):
    def test_receipts(self):
        for items, code, receipt, *_ in CASES:
            with self.subTest(items=items, code=code):
                self.assertEqual(Order(items, code).receipt(), receipt)

    def test_amounts_are_whole_cents(self):
        for items, code, _, subtotal, discount, tax, shipping, total in CASES:
            with self.subTest(items=items, code=code):
                order = Order(items, code)
                amounts = (order.subtotal, order.discount, order.tax, order.shipping, order.total)
                for amount in amounts:
                    self.assertIs(type(amount), int)
                self.assertEqual(amounts, (subtotal, discount, tax, shipping, total))

    def test_prices_are_cents(self):
        self.assertEqual((price("tea"), price("spoon"), price("cups")), (1999, 10, 200))
        self.assertIs(type(price("mug")), int)
        with self.assertRaises(KeyError):
            price("teapot")

    def test_large_orders_stay_exact(self):
        order = Order([("spoon", 1_000_003), ("mug", 99_999)], "SAVE15")
        self.assertEqual(order.subtotal, 10 * 1_000_003 + 750 * 99_999)
        self.assertEqual(order.discount, (order.subtotal * 15 + 50) // 100)
        self.assertEqual(order.total, order.subtotal - order.discount + order.tax + order.shipping)

    def test_dollars(self):
        self.assertEqual([dollars(c) for c in (1234, 5, 0, -500, 100000)], ["$12.34", "$0.05", "$0.00", "-$5.00", "$1000.00"])


class TestUnchanged(unittest.TestCase):
    def test_unknown_code(self):
        with self.assertRaises(ValueError):
            Order([("tea", 1)], "FREE")

    def test_no_code_no_discount_line(self):
        self.assertNotIn("Discount", Order([("mug", 2)]).receipt())


if __name__ == "__main__":
    unittest.main()
