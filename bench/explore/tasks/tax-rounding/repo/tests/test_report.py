import unittest

from billing.report import monthly_total


class ReportTest(unittest.TestCase):
    def test_adds_up_the_invoices(self):
        invoices = [{"region": "DE", "lines": [{"cents": 1000, "category": "tools"}]}]
        self.assertEqual(monthly_total(invoices), 1190)
