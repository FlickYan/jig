import unittest

from shop.errors import UnknownProduct
from shop.orders.cart import Cart


class CartTest(unittest.TestCase):
    def test_lines_merge_quantities(self):
        cart = Cart("c1")
        cart.add("SKU-100", 1)
        cart.add("SKU-200", 2)
        cart.add("SKU-100", 2)
        self.assertEqual(cart.lines(), [("SKU-100", 3), ("SKU-200", 2)])

    def test_unknown_product(self):
        with self.assertRaises(UnknownProduct):
            Cart("c1").add("SKU-999")
