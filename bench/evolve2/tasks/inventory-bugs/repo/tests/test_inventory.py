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
        self.assertEqual(weekly_report(stock), "2/3/2024 T1 +10\n3/3/2024 T1 -4")


if __name__ == "__main__":
    unittest.main()
