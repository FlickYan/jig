import os
import tempfile
import unittest

from catalog.importer import import_prices


class ImportTest(unittest.TestCase):
    def load(self, text):
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as f:
            f.write(text)
        try:
            return import_prices(f.name)
        finally:
            os.unlink(f.name)

    def test_the_line_that_broke_the_import(self):
        self.assertEqual(self.load('K-200, "Kettle, steel ""Classic""", 29.99, eur\n'), {"K-200": ('Kettle, steel "Classic"', 2999, "EUR")})

    def test_other_quoted_names(self):
        self.assertEqual(self.load('T-1,"Tea",3.20,EUR\nT-2, "Tea, green" ,4.00,EUR\n'), {"T-1": ("Tea", 320, "EUR"), "T-2": ("Tea, green", 400, "EUR")})

    def test_everything_else_as_before(self):
        text = "# supplier price list\n\n  M-1 ,  Mug , 4.50 , eur  \n# a comment\nS-9,Spoon,0.35,GBP\n"
        self.assertEqual(self.load(text), {"M-1": ("Mug", 450, "EUR"), "S-9": ("Spoon", 35, "GBP")})
