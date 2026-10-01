import unittest
from decimal import Decimal

from shop.catalog import Product, find, search

PRODUCTS = [
    Product("NB-A5", "Notebook A5, dotted", Decimal("4.50"), 0.3),
    Product("PEN-BL", "Gel pen, blue", Decimal("1.20"), 0.02),
    Product("NB-A4", "Notebook A4, lined", Decimal("5.90"), 0.5),
]


class CatalogTest(unittest.TestCase):
    def test_find(self):
        self.assertEqual(find(PRODUCTS, "pen-bl").name, "Gel pen, blue")
        with self.assertRaises(KeyError):
            find(PRODUCTS, "NOPE")

    def test_search(self):
        self.assertEqual([p.sku for p in search(PRODUCTS, "notebook")], ["NB-A4", "NB-A5"])
        self.assertEqual([p.sku for p in search(PRODUCTS, "A5 notebook")], ["NB-A5"])


if __name__ == "__main__":
    unittest.main()
