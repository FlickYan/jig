import contextlib
import io
import os
import tempfile
import unittest

from bank.cli import main

HISTORY = [('2024-02-10', 'open', 'A1', 'Ada'), ('2024-02-10', 'deposit', 'A1', '100.00'), ('2024-02-25', 'withdraw', 'A1', '20.50'), ('2024-02-26', 'open', 'B2', 'Bob'), ('2024-03-01', 'deposit', 'B2', '50'), ('2024-03-05', 'transfer', 'A1', 'B2', '30.00'), ('2024-03-31', 'deposit', 'A1', '5.25'), ('2024-04-01', 'withdraw', 'A1', '10'), ('2024-04-01', 'open', 'C3', 'Cy')]
EXPECTED = [('A1', '2024-03', (0, '{\n  "account": "A1",\n  "closing_balance": "54.75",\n  "month": "2024-03",\n  "opening_balance": "79.50",\n  "transactions": [\n    {\n      "amount": "-30.00",\n      "balance": "49.50",\n      "date": "2024-03-05",\n      "kind": "transfer",\n      "to": "B2"\n    },\n    {\n      "amount": "5.25",\n      "balance": "54.75",\n      "date": "2024-03-31",\n      "kind": "deposit"\n    }\n  ]\n}\n', '')), ('B2', '2024-03', (0, '{\n  "account": "B2",\n  "closing_balance": "80.00",\n  "month": "2024-03",\n  "opening_balance": "0.00",\n  "transactions": [\n    {\n      "amount": "50.00",\n      "balance": "50.00",\n      "date": "2024-03-01",\n      "kind": "deposit"\n    },\n    {\n      "amount": "30.00",\n      "balance": "80.00",\n      "date": "2024-03-05",\n      "from": "A1",\n      "kind": "transfer"\n    }\n  ]\n}\n', '')), ('A1', '2024-02', (0, '{\n  "account": "A1",\n  "closing_balance": "79.50",\n  "month": "2024-02",\n  "opening_balance": "0.00",\n  "transactions": [\n    {\n      "amount": "100.00",\n      "balance": "100.00",\n      "date": "2024-02-10",\n      "kind": "deposit"\n    },\n    {\n      "amount": "-20.50",\n      "balance": "79.50",\n      "date": "2024-02-25",\n      "kind": "withdraw"\n    }\n  ]\n}\n', '')), ('A1', '2024-01', (0, '{\n  "account": "A1",\n  "closing_balance": "0.00",\n  "month": "2024-01",\n  "opening_balance": "0.00",\n  "transactions": []\n}\n', '')), ('A1', '2024-05', (0, '{\n  "account": "A1",\n  "closing_balance": "44.75",\n  "month": "2024-05",\n  "opening_balance": "44.75",\n  "transactions": []\n}\n', '')), ('C3', '2024-04', (0, '{\n  "account": "C3",\n  "closing_balance": "0.00",\n  "month": "2024-04",\n  "opening_balance": "0.00",\n  "transactions": []\n}\n', '')), ('B2', '2024-04', (0, '{\n  "account": "B2",\n  "closing_balance": "80.00",\n  "month": "2024-04",\n  "opening_balance": "80.00",\n  "transactions": []\n}\n', ''))]
EXPECTED_ERRORS = [('a1', '2024-03', (2, '', 'error: invalid account: a1\n')), ('A9', '2024-03', (1, '', 'error: unknown account: A9\n')), ('A1', '2024-3', (2, '', 'error: invalid month: 2024-3 (use YYYY-MM)\n')), ('A1', '2024-13', (2, '', 'error: invalid month: 2024-13 (use YYYY-MM)\n')), ('A1', '24-03', (2, '', 'error: invalid month: 24-03 (use YYYY-MM)\n')), ('A1', '2024-00', (2, '', 'error: invalid month: 2024-00 (use YYYY-MM)\n')), ('1', '2024-03', (2, '', 'error: invalid account: 1\n'))]


class TestStatement(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        self.db, self.log = os.path.join(folder, "bank.json"), os.path.join(folder, "audit.log")
        for day, *argv in HISTORY:
            self.assertEqual(self.run_bank(*argv, today=day)[0], 0, argv)

    def run_bank(self, *argv, today=None):
        os.environ.update({"BANK_DB": self.db, "BANK_AUDIT": self.log})
        os.environ.pop("BANK_TODAY", None)
        if today:
            os.environ["BANK_TODAY"] = today
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = main(list(argv))
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def test_statements(self):
        for account, month, expected in EXPECTED:
            with self.subTest(account=account, month=month):
                self.assertEqual(self.run_bank("statement", account, "--month", month), tuple(expected))

    def test_errors_like_the_other_commands(self):
        for account, month, expected in EXPECTED_ERRORS:
            with self.subTest(account=account, month=month):
                self.assertEqual(self.run_bank("statement", account, "--month", month), tuple(expected))

    def test_a_month_is_required(self):
        code, out, _ = self.run_bank("statement", "A1")
        self.assertEqual((code, out), (2, ""))

    def test_a_statement_changes_nothing(self):
        with open(self.db) as file:
            db = file.read()
        with open(self.log) as file:
            log = file.read()
        for account, month in (("A1", "2024-03"), ("B2", "2024-04"), ("A9", "2024-03")):
            self.run_bank("statement", account, "--month", month, today="2024-06-01")
        with open(self.db) as file:
            self.assertEqual(file.read(), db, "the accounts changed")
        with open(self.log) as file:
            self.assertEqual(file.read(), log, "a statement wrote to the audit log")


if __name__ == "__main__":
    unittest.main()
