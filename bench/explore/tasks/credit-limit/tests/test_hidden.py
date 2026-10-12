import contextlib
import io
import unittest

from shop.api import post_order
from shop.cli import main
from shop.errors import Refused
from shop.orders import place_order


def cli(*argv):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return main(list(argv))


class CreditTest(unittest.TestCase):
    def setUp(self):
        import shop.orders
        shop.orders.PLACED.clear()  # so that counting orders placed earlier, too, is no mistake

    def test_counts_what_is_already_owed(self):
        # c1: limit 5000.00, owes 800.00 unpaid (the paid invoice doesn't count)
        place_order("c1", {"coffee": 46})  # 4140.00: 4940.00 in all
        with self.assertRaises(Refused):
            place_order("c1", {"coffee": 47})  # 4230.00: 5030.00

    def test_an_override_wins_over_the_customer_record(self):
        # c2: 2000.00 in customers.json, 500.00 by override, owes 300.00
        place_order("c2", {"flour": 8})  # 200.00: 500.00 in all
        with self.assertRaises(Refused):
            place_order("c2", {"flour": 9})

    def test_trusted_customers_have_no_limit(self):
        place_order("c3", {"coffee": 500})

    def test_both_front_ends_refuse(self):
        status, body = post_order({"customer": "c2", "items": {"coffee": 3}})
        self.assertEqual(status, 409)
        self.assertIn("error", body)
        self.assertEqual(cli("order", "c2", "coffee=3"), 4)
        self.assertEqual(cli("order", "c2", "flour=1"), 0)
