from maketask import task

CATALOG = '''
    from dataclasses import dataclass


    @dataclass
    class Product:
        sku: str
        name: str
        price_cents: int


    class Catalog:
        def __init__(self):
            self.products = {}

        def add(self, product):
            self.products[product.sku] = product

        def get(self, sku):
            if sku not in self.products:
                raise KeyError(f"no product {sku}")
            return self.products[sku]

        def set_price(self, sku, cents):
            self.get(sku).price_cents = cents


    CATALOG = Catalog()  # the shop's catalog
'''
PRICING_BUGGY = '''
    from functools import lru_cache

    from .catalog import CATALOG


    @lru_cache(maxsize=None)
    def unit_price(sku):
        """A product's price in cents. Looked up for every order line, so it is cached."""
        return CATALOG.get(sku).price_cents
'''
PRICING_FIXED = '''
    from .catalog import CATALOG


    def unit_price(sku):
        """A product's price in cents: the catalog's, as it is now."""
        return CATALOG.get(sku).price_cents
'''
IMPORTER_BUGGY = '''
    import csv

    from .catalog import CATALOG, Product


    def import_csv(path):
        """Adds the products in a supplier's CSV (columns sku, name, price) to the catalog; returns how many."""
        count = 0
        with open(path, newline="", encoding="utf-8") as file:
            for row in csv.DictReader(file):
                row = {key.strip(): value.strip() for key, value in row.items()}
                CATALOG.add(Product(row["sku"], row["name"], _cents(row["price"])))
                count += 1
        return count


    def _cents(text):
        dollars, _, cents = text.partition(".")
        return int(dollars) * 100 + int((cents + "00")[:2])
'''
IMPORTER_FIXED = IMPORTER_BUGGY.replace('''        with open(path, newline="", encoding="utf-8") as file:''', '''        # utf-8-sig: Excel starts the CSVs it writes with a byte-order mark.
        with open(path, newline="", encoding="utf-8-sig") as file:''')
assert "utf-8-sig" in IMPORTER_FIXED
STOCK = '''
    from dataclasses import dataclass


    @dataclass
    class Movement:
        date: str  # D/M/YYYY, as the warehouse writes it
        sku: str
        quantity: int  # positive in, negative out


    class Stock:
        def __init__(self):
            self.movements = []

        def record(self, date, sku, quantity):
            self.movements.append(Movement(date, sku, quantity))

        def level(self, sku):
            return sum(m.quantity for m in self.movements if m.sku == sku)
'''
ORDERS = '''
    from .pricing import unit_price


    def order_total(lines):
        """The total, in cents, of order lines (sku, quantity)."""
        return sum(unit_price(sku) * quantity for sku, quantity in lines)
'''
REPORT_BUGGY = '''
    def weekly_report(stock):
        """The week's movements, one line each, in date order: "D/M/YYYY sku quantity"."""
        lines = []
        for movement in sorted(stock.movements, key=lambda m: m.date):
            lines.append(f"{movement.date} {movement.sku} {movement.quantity:+d}")
        return "\\n".join(lines)
'''
REPORT_FIXED = '''
    from datetime import datetime


    def weekly_report(stock):
        """The week's movements, one line each, in date order: "D/M/YYYY sku quantity"."""
        lines = []
        for movement in sorted(stock.movements, key=lambda m: datetime.strptime(m.date, "%d/%m/%Y")):
            lines.append(f"{movement.date} {movement.sku} {movement.quantity:+d}")
        return "\\n".join(lines)
'''
ISSUE = '''
    # Problems reported by the shop

    1. **The supplier's file won't import.** This month's price list, which the supplier now exports from
       Excel, fails with `KeyError: 'sku'`. The file looks fine: it opens in Excel, and its first line is
       `sku,name,price` like last month's. A copy is in `examples/supplier-march.csv`.

    2. **Price changes don't reach orders.** After we lowered the price of a product, orders still came to
       the old total, until we restarted the service. An order should always use the current price.

    3. **The weekly report is out of order.** It listed the movements of 10/3/2024 before those of
       9/3/2024. It should list them in date order (and keep the order they were recorded in, for the same
       day).
'''
files = {
    "ISSUE.md": ISSUE,
    "inventory/__init__.py": '"""A small shop\'s products, stock and reports."""\n',
    "inventory/catalog.py": CATALOG,
    "inventory/pricing.py": PRICING_BUGGY,
    "inventory/importer.py": IMPORTER_BUGGY,
    "inventory/stock.py": STOCK,
    "inventory/orders.py": ORDERS,
    "inventory/report.py": REPORT_BUGGY,
    "tests/__init__.py": "",
    "tests/test_inventory.py": '''
        import unittest

        from inventory.catalog import CATALOG, Product
        from inventory.orders import order_total
        from inventory.report import weekly_report
        from inventory.stock import Stock


        class TestInventory(unittest.TestCase):
            def test_order_total(self):
                CATALOG.add(Product("T1", "Tea", 450))
                self.assertEqual(order_total([("T1", 2)]), 900)

            def test_stock_and_report(self):
                stock = Stock()
                stock.record("2/3/2024", "T1", 10)
                stock.record("3/3/2024", "T1", -4)
                self.assertEqual(stock.level("T1"), 6)
                self.assertEqual(weekly_report(stock), "2/3/2024 T1 +10\\n3/3/2024 T1 -4")


        if __name__ == "__main__":
            unittest.main()
    ''',
}
HIDDEN = r'''
import os
import tempfile
import unittest

from inventory.catalog import CATALOG, Product
from inventory.importer import import_csv
from inventory.orders import order_total
from inventory.report import weekly_report
from inventory.stock import Stock


def write(text, encoding):
    handle, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(handle, "wb") as file:
        file.write(text.encode(encoding))
    return path


class TestIssues(unittest.TestCase):
    def test_a_file_from_excel_imports(self):
        path = write("sku,name,price\r\nA1,Assam,4.50\r\nD2,Darjeeling ,12.5\r\n", "utf-8-sig")
        self.assertEqual(import_csv(path), 2)
        self.assertEqual((CATALOG.get("A1").price_cents, CATALOG.get("D2").name, CATALOG.get("D2").price_cents), (450, "Darjeeling", 1250))

    def test_a_file_without_a_byte_order_mark_still_imports(self):
        path = write("sku , name , price\nG3,Genmaicha,3\n", "utf-8")
        self.assertEqual(import_csv(path), 1)
        self.assertEqual(CATALOG.get("G3").price_cents, 300)

    def test_an_order_uses_the_current_price(self):
        CATALOG.add(Product("P1", "Pu-erh", 900))
        self.assertEqual(order_total([("P1", 2)]), 1800)
        CATALOG.set_price("P1", 750)
        self.assertEqual(order_total([("P1", 2)]), 1500)
        CATALOG.add(Product("P1", "Pu-erh", 1000))
        self.assertEqual(order_total([("P1", 1)]), 1000)

    def test_a_price_imported_again_counts_too(self):
        import_csv(write("sku,name,price\nR4,Rooibos,2.00\n", "utf-8-sig"))
        self.assertEqual(order_total([("R4", 3)]), 600)
        import_csv(write("sku,name,price\nR4,Rooibos,2.50\n", "utf-8-sig"))
        self.assertEqual(order_total([("R4", 3)]), 750)

    def test_the_report_is_in_date_order(self):
        stock = Stock()
        for date, sku, quantity in [("10/3/2024", "A1", 5), ("9/3/2024", "B2", 3), ("28/2/2024", "C3", -1), ("1/4/2024", "A1", -2), ("9/3/2024", "A1", 7), ("10/3/2024", "B2", -3)]:
            stock.record(date, sku, quantity)
        self.assertEqual(weekly_report(stock).splitlines(), [
            "28/2/2024 C3 -1", "9/3/2024 B2 +3", "9/3/2024 A1 +7", "10/3/2024 A1 +5", "10/3/2024 B2 -3", "1/4/2024 A1 -2",
        ])

    def test_years_count_too(self):
        stock = Stock()
        stock.record("2/1/2025", "A1", 1)
        stock.record("30/12/2024", "A1", 2)
        self.assertEqual(weekly_report(stock), "30/12/2024 A1 +2\n2/1/2025 A1 +1")


class TestUnchanged(unittest.TestCase):
    def test_stock_levels(self):
        stock = Stock()
        stock.record("1/3/2024", "Z9", 10)
        stock.record("2/3/2024", "Z9", -3)
        stock.record("2/3/2024", "Y8", 4)
        self.assertEqual((stock.level("Z9"), stock.level("Y8"), stock.level("X7")), (7, 4, 0))
        self.assertEqual(weekly_report(Stock()), "")

    def test_unknown_product(self):
        with self.assertRaises(KeyError):
            order_total([("NOPE", 1)])


if __name__ == "__main__":
    unittest.main()
'''
task(
    "inventory-bugs",
    "Fix the problems the shop reported in ISSUE.md, without changing anything else about how the inventory package behaves.",
    ["python", "bugs", "many files"],
    {**files, "examples/supplier-march.csv": "﻿sku,name,price\nA1,Assam,4.50\nE5,Earl Grey,5.25\n"},
    HIDDEN,
    {"inventory/pricing.py": PRICING_FIXED, "inventory/importer.py": IMPORTER_FIXED, "inventory/report.py": REPORT_FIXED},
)
