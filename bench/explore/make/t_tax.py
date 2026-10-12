"""tax-rounding: the symptom is in a report, the cause in a helper reached only through plugins.

What the agent must find: the monthly report only adds up invoices; each invoice's tax comes from a
region plugin, loaded by name (config/regions.txt -> billing/regions/<name>.py), and every plugin calls
billing/money.tax(), which truncates to the cent instead of rounding half up as docs/money.md requires.
Rounding in the report hides the symptom for some months and leaves every invoice wrong.
"""
from maketask import task

FILES = {
    "README.md": """
        # billing

        Invoices and the monthly report. How money is computed is described in docs/money.md.
        """,
    "docs/money.md": """
        # Money

        - Amounts are kept in whole cents (int) everywhere.
        - Tax is computed per invoice line and rounded to the nearest cent, halves away from zero
          (12.5 cents is 13 cents, -12.5 is -13).
        - Totals are sums of rounded line amounts: never round a sum again.
        """,
    "config/regions.txt": """
        # region code -> plugin module in billing/regions/
        DE de
        FR fr
        UK uk
        """,
    "billing/__init__.py": "",
    "billing/money.py": """
        def tax(cents, rate_percent):
            \"\"\"The tax on an amount in cents, at a rate in percent, in cents.\"\"\"
            return int(cents * rate_percent / 100)
        """,
    "billing/regions/__init__.py": """
        import importlib
        import os

        HERE = os.path.dirname(__file__)


        def plugin(region):
            \"\"\"The tax rules of a region, as listed in config/regions.txt.\"\"\"
            path = os.path.join(HERE, "..", "..", "config", "regions.txt")
            with open(path) as f:
                for line in f:
                    if line.strip() and not line.startswith("#"):
                        code, module = line.split()
                        if code == region:
                            return importlib.import_module(f"billing.regions.{module}")
            raise KeyError(f"no tax rules for region {region}")
        """,
    "billing/regions/de.py": """
        from billing.money import tax

        STANDARD, REDUCED = 19, 7


        def line_tax(cents, category):
            return tax(cents, REDUCED if category == "food" else STANDARD)
        """,
    "billing/regions/fr.py": """
        from billing.money import tax

        RATES = {"food": 5.5, "books": 5.5, "default": 20}


        def line_tax(cents, category):
            return tax(cents, RATES.get(category, RATES["default"]))
        """,
    "billing/regions/uk.py": """
        from billing.money import tax


        def line_tax(cents, category):
            return 0 if category in ("food", "books") else tax(cents, 20)
        """,
    "billing/invoice.py": """
        from billing.regions import plugin


        def invoice_total(invoice):
            \"\"\"Net plus tax, in cents: each line's tax by the customer's region.\"\"\"
            rules = plugin(invoice["region"])
            return sum(line["cents"] + rules.line_tax(line["cents"], line["category"]) for line in invoice["lines"])
        """,
    "billing/report.py": """
        from billing.invoice import invoice_total


        def monthly_total(invoices):
            \"\"\"What the month's invoices add up to, in cents.\"\"\"
            return sum(invoice_total(invoice) for invoice in invoices)
        """,
    "ISSUE.md": """
        # Monthly totals are a few cents short

        The monthly report for September came out at 1,234.17 EUR, but the invoices we sent add up to
        1,234.21 EUR when our accountant adds them by hand. It's always a few cents too little, never too much.
        """,
    "tests/__init__.py": "",
    "tests/test_report.py": """
        import unittest

        from billing.report import monthly_total


        class ReportTest(unittest.TestCase):
            def test_adds_up_the_invoices(self):
                invoices = [{"region": "DE", "lines": [{"cents": 1000, "category": "tools"}]}]
                self.assertEqual(monthly_total(invoices), 1190)
        """,
}

SOLUTION = {
    "billing/money.py": """
        from decimal import ROUND_HALF_UP, Decimal


        def tax(cents, rate_percent):
            \"\"\"The tax on an amount in cents, at a rate in percent, in cents, rounded half away from zero.\"\"\"
            exact = Decimal(cents) * Decimal(str(rate_percent)) / 100
            return int(exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        """,
}

HIDDEN = """
    import unittest

    from billing.invoice import invoice_total
    from billing.money import tax
    from billing.regions import plugin
    from billing.report import monthly_total


    class TaxTest(unittest.TestCase):
        def test_tax_is_rounded_to_the_nearest_cent(self):
            self.assertEqual(tax(999, 19), 190)  # 189.81
            self.assertEqual(tax(250, 5), 13)  # 12.5: halves away from zero
            self.assertEqual(tax(-250, 5), -13)
            self.assertEqual(tax(1001, 20), 200)  # 200.2
            self.assertEqual(tax(1, 5.5), 0)  # 0.055

        def test_every_region_rounds(self):
            self.assertEqual(plugin("DE").line_tax(999, "tools"), 190)
            self.assertEqual(plugin("FR").line_tax(999, "food"), 55)  # 54.945
            self.assertEqual(plugin("UK").line_tax(1999, "tools"), 400)  # 399.8

        def test_an_invoice_adds_rounded_lines(self):
            invoice = {"region": "FR", "lines": [{"cents": 999, "category": "food"}, {"cents": 1999, "category": "tools"}]}
            self.assertEqual(invoice_total(invoice), 999 + 55 + 1999 + 400)

        def test_the_month_is_the_sum_of_its_invoices(self):
            invoices = [
                {"region": "DE", "lines": [{"cents": 999, "category": "tools"}, {"cents": 333, "category": "food"}]},
                {"region": "UK", "lines": [{"cents": 1999, "category": "tools"}, {"cents": 500, "category": "books"}]},
            ]
            totals = [invoice_total(invoice) for invoice in invoices]
            self.assertEqual(totals, [999 + 190 + 333 + 23, 1999 + 400 + 500])
            self.assertEqual(monthly_total(invoices), sum(totals))
"""

task(
    "tax-rounding",
    "Fix the problem reported in ISSUE.md.",
    ["python", "bug", "indirection", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
