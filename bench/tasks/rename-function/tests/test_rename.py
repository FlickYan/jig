import pathlib
import re
import subprocess
import sys
import unittest
import warnings

from billing.invoice import invoice
from billing.reports import largest_invoice, monthly_revenue
from billing.totals import calc_total, calculate_total


class RenameTest(unittest.TestCase):
    def test_new_name(self):
        self.assertEqual(calculate_total([(2, 1500), (1, 999)], tax_rate=0.2), 4799)

    def test_old_name_warns_but_works(self):
        with self.assertWarns(DeprecationWarning):
            self.assertEqual(calc_total([(1, 1000)], 0.2), 1200)

    def test_callers_use_the_new_name_without_warnings(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error", DeprecationWarning)
            self.assertEqual(invoice("acme", [(1, 1000)], 0.2)["total"], 1200)
            invoices = [{"lines": [(1, 1000)], "tax_rate": 0.2}, {"lines": [(3, 250)]}]
            self.assertEqual(monthly_revenue(invoices), 1950)
            self.assertEqual(largest_invoice(invoices), invoices[0])

    def test_no_old_name_left_outside_the_alias(self):
        for path in ["billing/invoice.py", "billing/reports.py", "scripts/monthly.py", "README.md"]:
            text = pathlib.Path(path).read_text()
            self.assertIn("calculate_total", text, path)
            if path != "README.md":
                self.assertIsNone(re.search(r"\bcalc_total\b", text), path)

    def test_script_runs(self):
        result = subprocess.run([sys.executable, "scripts/monthly.py"], capture_output=True, text=True, env={"PYTHONPATH": "."})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Revenue: 1950", result.stdout)


if __name__ == "__main__":
    unittest.main()
