import os
import tempfile
import unittest

from catalog.importer import import_prices


class ImporterTest(unittest.TestCase):
    def test_reads_a_price_list(self):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
            f.write("# sku, name, price, currency\nM-1, Mug, 4.50, EUR\n")
        try:
            self.assertEqual(import_prices(f.name), {"M-1": ("Mug", 450, "EUR")})
        finally:
            os.unlink(f.name)
