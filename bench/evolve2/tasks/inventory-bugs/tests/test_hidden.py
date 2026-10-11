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
