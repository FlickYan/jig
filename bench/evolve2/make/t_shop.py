from maketask import task

CATALOG_FLOAT = '''
    # Prices in dollars.
    PRICES = {"tea": 19.99, "mug": 7.50, "honey": 4.25, "spoon": 0.10, "cups": 2.00, "kettle": 39.95, "jam": 3.35}


    def price(sku):
        if sku not in PRICES:
            raise KeyError(f"no such product: {sku}")
        return PRICES[sku]
'''
CATALOG_CENTS = '''
    # Prices in cents.
    PRICES = {"tea": 1999, "mug": 750, "honey": 425, "spoon": 10, "cups": 200, "kettle": 3995, "jam": 335}


    def price(sku):
        if sku not in PRICES:
            raise KeyError(f"no such product: {sku}")
        return PRICES[sku]
'''
DISCOUNTS_FLOAT = '''
    CODES = {"SAVE10": 10, "SAVE15": 15, "HALF": 50}  # percent off the subtotal


    def discount(subtotal, code):
        if code is None:
            return 0.0
        if code not in CODES:
            raise ValueError(f"unknown discount code: {code}")
        return round(subtotal * CODES[code] / 100, 2)
'''
DISCOUNTS_CENTS = '''
    CODES = {"SAVE10": 10, "SAVE15": 15, "HALF": 50}  # percent off the subtotal
    MINIMUM = {"SAVE15": 5000}  # the subtotal, in cents, a code needs to take anything off


    def discount(subtotal, code):
        """The discount, in cents, on a subtotal in cents: rounded to the nearest cent, halves up."""
        if code is None:
            return 0
        if code not in CODES:
            raise ValueError(f"unknown discount code: {code}")
        if subtotal < MINIMUM.get(code, 0):
            return 0
        return (subtotal * CODES[code] + 50) // 100
'''
TAX_FLOAT = '''
    RATE = 0.0825


    def tax(amount):
        return round(amount * RATE, 2)
'''
TAX_CENTS = '''
    RATE_BASIS_POINTS = 825  # 8.25%


    def tax(amount):
        """The tax, in cents, on an amount in cents: rounded to the nearest cent, halves up."""
        return (amount * RATE_BASIS_POINTS + 5000) // 10000
'''
MONEY_FLOAT = '''
    def dollars(amount):
        """An amount as the receipt shows it: $12.34, or -$5.00."""
        return f"-${-amount:.2f}" if amount < 0 else f"${amount:.2f}"
'''
MONEY_CENTS = '''
    def dollars(cents):
        """An amount in cents as the receipt shows it: $12.34, or -$5.00."""
        sign = "-" if cents < 0 else ""
        cents = abs(cents)
        return f"{sign}${cents // 100}.{cents % 100:02d}"
'''
ORDER_NEW = '''
    from .catalog import price
    from .discounts import discount
    from .money import dollars
    from .tax import tax

    FREE_SHIPPING_FROM = 3500  # cents, after the discount
    SHIPPING = 499


    class Order:
        def __init__(self, items, code=None):
            """items: (sku, quantity) pairs. Lines of the same product are merged, in the order they first appear."""
            quantities = {}
            for sku, quantity in items:
                price(sku)
                quantities[sku] = quantities.get(sku, 0) + quantity
            self.lines = [(sku, quantity, price(sku) * self._paid(sku, quantity)) for sku, quantity in quantities.items()]
            self.code = code
            discount(0, code)  # an unknown code fails now, not later

        @staticmethod
        def _paid(sku, quantity):
            """Three teas for the price of two."""
            return quantity - quantity // 3 if sku == "tea" else quantity

        @property
        def subtotal(self):
            return sum(total for _, _, total in self.lines)

        @property
        def discount(self):
            return discount(self.subtotal, self.code)

        @property
        def tax(self):
            return tax(self.subtotal - self.discount)

        @property
        def shipping(self):
            return 0 if self.subtotal - self.discount >= FREE_SHIPPING_FROM else SHIPPING

        @property
        def total(self):
            return self.subtotal - self.discount + self.tax + self.shipping

        def receipt(self):
            out = [f"{sku} x{quantity}  {dollars(total)}" for sku, quantity, total in self.lines]
            out.append(f"Subtotal  {dollars(self.subtotal)}")
            if self.discount:
                out.append(f"Discount {self.code}  {dollars(-self.discount)}")
            out.append(f"Tax  {dollars(self.tax)}")
            if self.shipping:
                out.append(f"Shipping  {dollars(self.shipping)}")
            out.append(f"Total  {dollars(self.total)}")
            return "\\n".join(out)
'''
ORDER = '''
    from .catalog import price
    from .discounts import discount
    from .money import dollars
    from .tax import tax


    class Order:
        def __init__(self, items, code=None):
            """items: (sku, quantity) pairs."""
            self.lines = [(sku, quantity, price(sku) * quantity) for sku, quantity in items]
            self.code = code
            discount(0, code)  # an unknown code fails now, not later

        @property
        def subtotal(self):
            return sum(total for _, _, total in self.lines)

        @property
        def discount(self):
            return discount(self.subtotal, self.code)

        @property
        def tax(self):
            return tax(self.subtotal - self.discount)

        @property
        def total(self):
            return self.subtotal - self.discount + self.tax

        def receipt(self):
            out = [f"{sku} x{quantity}  {dollars(total)}" for sku, quantity, total in self.lines]
            out.append(f"Subtotal  {dollars(self.subtotal)}")
            if self.code:
                out.append(f"Discount {self.code}  {dollars(-self.discount)}")
            out.append(f"Tax  {dollars(self.tax)}")
            out.append(f"Total  {dollars(self.total)}")
            return "\\n".join(out)
'''
ISSUE = '''
    # Receipts are a cent off

    Customers keep finding receipts a cent off. Tea with the HALF code came to $10.82, when half of $19.99
    is $9.995, which is $10.00 off, and the total $10.81; three packs of cups came to $6.49 instead of
    $6.50. The shop does its sums in floating point, and rounds them in more than one way.

    Make the shop keep money in whole cents, as ints, everywhere: the prices in the catalog, each line's
    total, and an order's `subtotal`, `discount`, `tax` and `total` (so `Order.tax` is an int number of
    cents, and so on). Money is rounded in two places only, both to the nearest cent with halves rounded
    up:

    - the discount: the code's percentage of the subtotal;
    - the tax: 8.25% of the subtotal less the discount.

    The total is the subtotal less the discount, plus the tax. Receipts look exactly as they do now.

    ## Also needed

    - **Lines are merged.** An order lists each product once, with its whole quantity, in the order the
      products first appear: tea x1 and later tea x2 make one line, `tea x3`.
    - **Three for two on tea.** Every third tea in an order is free: the tea line shows the price of the
      teas paid for (`tea x3  $39.98`), and the subtotal counts only those.
    - **SAVE15 needs $50.** SAVE15 takes 15% off only when the subtotal (after three for two) is at least
      $50.00; below that it takes nothing off. SAVE10 and HALF have no minimum. A receipt shows the
      discount line only when the discount isn't zero.
    - **Shipping.** An order whose subtotal less the discount is under $35.00 pays $4.99 shipping, on a
      line `Shipping  $4.99` after the tax line; from $35.00 it ships free, with no shipping line.
      Shipping isn't taxed. `Order.shipping` is the fee in cents (0 when free), and the total includes it.
'''
VISIBLE = '''
    import unittest

    from shop.order import Order


    class TestOrders(unittest.TestCase):
        def test_receipt(self):
            order = Order([("tea", 2), ("mug", 1)])
            self.assertEqual(order.receipt(), "tea x2  $39.98\\nmug x1  $7.50\\nSubtotal  $47.48\\nTax  $3.92\\nTotal  $51.40")

        def test_discount_code(self):
            order = Order([("kettle", 1)], "SAVE10")
            self.assertEqual(order.receipt().splitlines()[-3:], ["Discount SAVE10  -$4.00", "Tax  $2.97", "Total  $38.92"])

        def test_unknown_code(self):
            with self.assertRaises(ValueError):
                Order([("tea", 1)], "FREE")


    if __name__ == "__main__":
        unittest.main()
'''

import importlib, sys, types, pathlib, textwrap
# Build the cents version in memory to compute the hidden expectations.
pkg = types.ModuleType("shop"); pkg.__path__ = []; sys.modules["shop"] = pkg
for name, src in (("catalog", CATALOG_CENTS), ("discounts", DISCOUNTS_CENTS), ("tax", TAX_CENTS), ("money", MONEY_CENTS), ("order", ORDER_NEW)):
    module = types.ModuleType(f"shop.{name}"); module.__package__ = "shop"; sys.modules[f"shop.{name}"] = module
    exec(compile(textwrap.dedent(src).replace("\\\\n", "\\n"), f"shop/{name}.py", "exec"), module.__dict__)
Order = sys.modules["shop.order"].Order
RECEIPTS = [
    ([("tea", 1)], "HALF"), ([("cups", 3)], None), ([("honey", 1)], "HALF"), ([("mug", 1)], "SAVE15"), ([("spoon", 1)], "SAVE15"),
    ([("spoon", 3)], "SAVE15"), ([("kettle", 2)], "SAVE15"), ([("tea", 3), ("jam", 7)], "SAVE10"), ([("cups", 6)], "HALF"), ([("honey", 3), ("spoon", 2)], None),
    ([("jam", 1)], None), ([("tea", 2), ("mug", 1)], None),
    ([("tea", 3)], None), ([("tea", 5)], "SAVE10"), ([("tea", 6), ("spoon", 1)], None), ([("tea", 1), ("mug", 1), ("tea", 2)], None),
    ([("kettle", 1), ("honey", 3)], "SAVE15"), ([("kettle", 1), ("cups", 5)], "SAVE15"), ([("tea", 3), ("jam", 3)], "SAVE15"),
    ([("mug", 4), ("cups", 2), ("spoon", 9), ("jam", 1)], None), ([("mug", 4), ("cups", 2), ("spoon", 10)], None), ([("kettle", 2)], "HALF"), ([("mug", 4)], "HALF"),
]
cases = [(items, code, Order(items, code).receipt(), Order(items, code).subtotal, Order(items, code).discount, Order(items, code).tax, Order(items, code).shipping, Order(items, code).total) for items, code in RECEIPTS]

HIDDEN = f'''
import unittest

from shop.catalog import price
from shop.money import dollars
from shop.order import Order

CASES = {cases!r}


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
'''

files = {
    "ISSUE.md": ISSUE,
    "shop/__init__.py": '"""A small shop\'s orders and receipts."""\n',
    "shop/catalog.py": CATALOG_FLOAT,
    "shop/discounts.py": DISCOUNTS_FLOAT,
    "shop/tax.py": TAX_FLOAT,
    "shop/money.py": MONEY_FLOAT,
    "shop/order.py": ORDER,
    "tests/__init__.py": "",
    "tests/test_orders.py": VISIBLE,
}
solution = {"shop/catalog.py": CATALOG_CENTS, "shop/discounts.py": DISCOUNTS_CENTS, "shop/tax.py": TAX_CENTS, "shop/money.py": MONEY_CENTS, "shop/order.py": ORDER_NEW}
task(
    "shop-cents",
    "Do what ISSUE.md asks of the shop package: keep money in whole cents, as it describes, and make the changes it lists under Also needed, without changing anything else about how the shop behaves.",
    ["python", "refactor", "money", "many files"],
    files,
    HIDDEN,
    solution,
)
for items, code, receipt, *_ in cases[:3]:
    print(items, code); print("   " + receipt.replace("\n", "\n   "))
