"""nightly-import: what broke is written only in the log.

What the agent must find: the latest of the three nightly logs in logs/ (the two before it succeeded)
shows the row that stopped the import: a quoted name holding a comma and doubled quotes, which the
importer's split(",") can't read. The fix is to read the file as CSV, keeping what the importer does to
every other row: comments and blank lines skipped, fields stripped, prices in cents, currencies upper case.
"""
from maketask import task

LOG_09 = """\
2026-10-09 02:00:01 INFO  nightly import started: incoming/prices-2026-10-09.csv
2026-10-09 02:00:01 INFO  imported 198 rows
2026-10-09 02:00:01 INFO  nightly import finished
"""
LOG_10 = """\
2026-10-10 02:00:01 INFO  nightly import started: incoming/prices-2026-10-10.csv
2026-10-10 02:00:01 INFO  imported 205 rows
2026-10-10 02:00:02 INFO  nightly import finished
"""
LOG_11 = '''\
2026-10-11 02:00:01 INFO  nightly import started: incoming/prices-2026-10-11.csv
2026-10-11 02:00:02 ERROR import failed at line 58
Traceback (most recent call last):
  File "catalog/nightly.py", line 12, in run
    rows = import_prices(path)
  File "catalog/importer.py", line 18, in import_prices
    sku, name, price, currency = [field.strip() for field in line.split(",")]
ValueError: too many values to unpack (expected 4)
2026-10-11 02:00:02 ERROR line 58: K-200, "Kettle, steel ""Classic""", 29.99, eur
2026-10-11 02:00:02 ERROR nightly import aborted; yesterday's prices stay in place
'''

FILES = {
    "README.md": """
        # catalog

        The supplier sends its price list every night; catalog/nightly.py imports it into the shop.
        Each night's log is in logs/.
        """,
    "catalog/__init__.py": "",
    "catalog/importer.py": """
        from decimal import Decimal


        def to_cents(price):
            return int((Decimal(price) * 100).quantize(Decimal("1")))


        def import_prices(path):
            \"\"\"The supplier's price list as {sku: (name, cents, currency)}. Lines starting with # and blank
            lines are skipped; spaces around fields don't count.\"\"\"
            prices = {}
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    sku, name, price, currency = [field.strip() for field in line.split(",")]
                    prices[sku] = (name, to_cents(price), currency.upper())
            return prices
        """,
    "catalog/nightly.py": """
        import logging
        import sys

        from catalog.importer import import_prices

        log = logging.getLogger("nightly")


        def run(path):
            log.info("nightly import started: %s", path)
            rows = import_prices(path)
            log.info("imported %d rows", len(rows))
            return rows


        if __name__ == "__main__":
            logging.basicConfig(level=logging.INFO)
            run(sys.argv[1])
        """,
    "tests/__init__.py": "",
    "tests/test_importer.py": """
        import os
        import tempfile
        import unittest

        from catalog.importer import import_prices


        class ImporterTest(unittest.TestCase):
            def test_reads_a_price_list(self):
                with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False) as f:
                    f.write("# sku, name, price, currency\\nM-1, Mug, 4.50, EUR\\n")
                try:
                    self.assertEqual(import_prices(f.name), {"M-1": ("Mug", 450, "EUR")})
                finally:
                    os.unlink(f.name)
        """,
}

SOLUTION = {
    "catalog/importer.py": """
        import csv
        from decimal import Decimal


        def to_cents(price):
            return int((Decimal(price) * 100).quantize(Decimal("1")))


        def import_prices(path):
            \"\"\"The supplier's price list as {sku: (name, cents, currency)}. Lines starting with # and blank
            lines are skipped; spaces around fields don't count. Fields may be quoted, as in CSV.\"\"\"
            prices = {}
            with open(path, encoding="utf-8", newline="") as f:
                lines = (line for line in f if line.strip() and not line.strip().startswith("#"))
                for row in csv.reader(lines, skipinitialspace=True):
                    sku, name, price, currency = [field.strip() for field in row]
                    prices[sku] = (name, to_cents(price), currency.upper())
            return prices
        """,
}

HIDDEN = '''
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
            self.assertEqual(self.load('K-200, "Kettle, steel ""Classic""", 29.99, eur\\n'), {"K-200": ('Kettle, steel "Classic"', 2999, "EUR")})

        def test_other_quoted_names(self):
            self.assertEqual(self.load('T-1,"Tea",3.20,EUR\\nT-2, "Tea, green" ,4.00,EUR\\n'), {"T-1": ("Tea", 320, "EUR"), "T-2": ("Tea, green", 400, "EUR")})

        def test_everything_else_as_before(self):
            text = "# supplier price list\\n\\n  M-1 ,  Mug , 4.50 , eur  \\n# a comment\\nS-9,Spoon,0.35,GBP\\n"
            self.assertEqual(self.load(text), {"M-1": ("Mug", 450, "EUR"), "S-9": ("Spoon", 35, "GBP")})
'''

task(
    "nightly-import",
    "Last night's price import failed. Fix the importer so that it handles what broke it, without changing how it imports anything else.",
    ["python", "bug", "logs", "exploration"],
    {**FILES, "logs/nightly-2026-10-09.log": LOG_09, "logs/nightly-2026-10-10.log": LOG_10, "logs/nightly-2026-10-11.log": LOG_11},
    HIDDEN,
    SOLUTION,
)
