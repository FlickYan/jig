"""credit-limit: the rule goes where both front ends meet, and the limit isn't the field it seems to be.

What the agent must find: the API and the CLI both place orders through shop/orders.place_order, so the
check belongs there; a customer's limit is customers.credit_limit(), which applies the overrides in
data/credit_overrides.json and gives trusted customers no limit at all, not the "limit" field of the
customer record; what they already owe is ledger.outstanding(); and refusals are errors.Refused, which the
API turns into 409 and the CLI into exit code 4. A check in one front end, or against the record's field,
fails the hidden tests.
"""
from maketask import task

FILES = {
    "README.md": """
        # shop

        Orders for the wholesale shop, placed through the HTTP API (shop/api.py) or by staff on the
        command line (shop/cli.py).
        """,
    "data/customers.json": """
        {
          "c1": {"name": "Ada's Cafe", "limit": 500000, "trusted": false},
          "c2": {"name": "Bob's Bakery", "limit": 200000, "trusted": false},
          "c3": {"name": "City Hotel", "limit": 100000, "trusted": true}
        }
        """,
    "data/credit_overrides.json": """
        {
          "_comment": "Temporary limits agreed with a customer; they win over the limit in customers.json.",
          "c2": 50000
        }
        """,
    "data/ledger.json": """
        {
          "c1": [{"invoice": "I-100", "cents": 120000, "paid": true}, {"invoice": "I-104", "cents": 80000, "paid": false}],
          "c2": [{"invoice": "I-101", "cents": 30000, "paid": false}]
        }
        """,
    "shop/__init__.py": "",
    "shop/data.py": """
        import json
        import os

        DATA = os.environ.get("SHOP_DATA", os.path.join(os.path.dirname(__file__), "..", "data"))


        def load(name):
            with open(os.path.join(DATA, f"{name}.json")) as f:
                return json.load(f)
        """,
    "shop/errors.py": """
        class ShopError(Exception):
            \"\"\"Base of the errors the front ends report to the user.\"\"\"


        class NotFound(ShopError):
            pass


        class Refused(ShopError):
            \"\"\"The shop won't do what was asked, for a reason the user should be told.\"\"\"
        """,
    "shop/customers.py": """
        from shop import data
        from shop.errors import NotFound


        def customer(customer_id):
            customers = data.load("customers")
            if customer_id not in customers:
                raise NotFound(f"no customer {customer_id}")
            return customers[customer_id]


        def credit_limit(customer_id):
            \"\"\"How much the customer may owe us in all, in cents; None for no limit. An override in
            credit_overrides.json wins over the customer's own limit; trusted customers have no limit.\"\"\"
            record = customer(customer_id)
            if record.get("trusted"):
                return None
            overrides = data.load("credit_overrides")
            return overrides.get(customer_id, record["limit"])
        """,
    "shop/ledger.py": """
        from shop import data


        def outstanding(customer_id):
            \"\"\"What the customer owes us now, in cents: their unpaid invoices.\"\"\"
            return sum(entry["cents"] for entry in data.load("ledger").get(customer_id, []) if not entry["paid"])
        """,
    "shop/orders.py": """
        PRICES = {"flour": 2500, "sugar": 1800, "coffee": 9000}  # cents per sack

        PLACED = []


        def total(items):
            return sum(PRICES[name] * quantity for name, quantity in items.items())


        def place_order(customer_id, items):
            \"\"\"Places an order and returns it.\"\"\"
            from shop.customers import customer

            customer(customer_id)
            order = {"customer": customer_id, "items": dict(items), "cents": total(items)}
            PLACED.append(order)
            return order
        """,
    "shop/api.py": """
        from shop.errors import NotFound, Refused
        from shop.orders import place_order


        def post_order(body):
            \"\"\"POST /orders: returns (status, body).\"\"\"
            try:
                order = place_order(body["customer"], body["items"])
            except NotFound as err:
                return 404, {"error": str(err)}
            except Refused as err:
                return 409, {"error": str(err)}
            return 201, order
        """,
    "shop/cli.py": """
        import sys

        from shop.errors import NotFound, Refused
        from shop.orders import place_order


        def main(argv):
            \"\"\"shop order CUSTOMER ITEM=QUANTITY...\"\"\"
            if len(argv) < 3 or argv[0] != "order":
                print("usage: shop order CUSTOMER ITEM=QUANTITY...", file=sys.stderr)
                return 2
            items = {name: int(quantity) for name, quantity in (arg.split("=") for arg in argv[2:])}
            try:
                order = place_order(argv[1], items)
            except NotFound as err:
                print(f"error: {err}", file=sys.stderr)
                return 3
            except Refused as err:
                print(f"refused: {err}", file=sys.stderr)
                return 4
            print(f"placed order for {order['cents'] / 100:.2f}")
            return 0
        """,
    "tests/__init__.py": "",
    "tests/test_orders.py": """
        import unittest

        from shop.api import post_order


        class OrderTest(unittest.TestCase):
            def test_places_an_order(self):
                status, body = post_order({"customer": "c1", "items": {"flour": 2}})
                self.assertEqual((status, body["cents"]), (201, 5000))
        """,
}

SOLUTION = {
    "shop/orders.py": """
        PRICES = {"flour": 2500, "sugar": 1800, "coffee": 9000}  # cents per sack

        PLACED = []


        def total(items):
            return sum(PRICES[name] * quantity for name, quantity in items.items())


        def place_order(customer_id, items):
            \"\"\"Places an order and returns it, unless it would take the customer over their credit limit.\"\"\"
            from shop.customers import credit_limit, customer
            from shop.errors import Refused
            from shop.ledger import outstanding

            customer(customer_id)
            cents = total(items)
            limit = credit_limit(customer_id)
            if limit is not None and outstanding(customer_id) + cents > limit:
                raise Refused(f"the order would take {customer_id} over their credit limit")
            order = {"customer": customer_id, "items": dict(items), "cents": cents}
            PLACED.append(order)
            return order
        """,
}

HIDDEN = """
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
"""

task(
    "credit-limit",
    "Orders that would take a customer over their credit limit must be refused, whether they come through the API or the command line.",
    ["python", "feature", "architecture", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
