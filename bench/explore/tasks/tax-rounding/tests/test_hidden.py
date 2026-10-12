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
