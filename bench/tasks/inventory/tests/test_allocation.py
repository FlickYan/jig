import unittest

from shop.errors import OutOfStock
from shop.inventory.allocation import allocate
from shop.inventory.reservations import Reservations
from shop.inventory.stock import Stock
from shop.orders.cart import Cart
from shop.orders.checkout import place_order
from shop.payments.gateway import FakeGateway


class AllocationTest(unittest.TestCase):
    def test_ordering_exactly_what_is_left(self):
        stock = Stock({"SKU-123": 3})
        allocate(stock, [("SKU-123", 3)])
        self.assertEqual(stock.available("SKU-123"), 0)

    def test_ordering_too_many_changes_nothing(self):
        stock = Stock({"SKU-123": 3, "SKU-100": 1})
        with self.assertRaises(OutOfStock):
            allocate(stock, [("SKU-100", 1), ("SKU-123", 4)])
        self.assertEqual((stock.available("SKU-100"), stock.available("SKU-123")), (1, 3))

    def test_checkout_of_the_last_items(self):
        stock = Stock({"SKU-100": 2, "SKU-200": 5})
        cart = Cart("c1")
        cart.add("SKU-100", 2)
        cart.add("SKU-200", 1)
        order = place_order(cart, stock, FakeGateway())
        self.assertEqual(order["total_cents"], 2 * 2400 + 700)
        self.assertEqual(stock.available("SKU-100"), 0)

    def test_reservations_still_stop_at_zero(self):
        reservations = Reservations(Stock({"SKU-310": 2}))
        reservations.reserve("cart-1", "SKU-310", 2)
        with self.assertRaises(OutOfStock):
            reservations.reserve("cart-2", "SKU-310", 1)


if __name__ == "__main__":
    unittest.main()
