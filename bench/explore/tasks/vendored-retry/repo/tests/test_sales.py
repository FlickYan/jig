import unittest

from reports.sales import fetch_report


class Answering:
    def get(self, path):
        return {"path": path}


class SalesTest(unittest.TestCase):
    def test_fetches_the_month(self):
        self.assertEqual(fetch_report(Answering(), "2026-01"), {"path": "/reports/sales/2026-01"})
