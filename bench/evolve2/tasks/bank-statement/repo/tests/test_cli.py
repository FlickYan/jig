import contextlib
import io
import json
import os
import tempfile
import unittest

from bank.cli import main


class TestCommands(unittest.TestCase):
    def setUp(self):
        folder = tempfile.mkdtemp()
        os.environ.update({"BANK_DB": os.path.join(folder, "bank.json"), "BANK_AUDIT": os.path.join(folder, "audit.log"), "BANK_TODAY": "2024-03-01"})
        self.log = os.environ["BANK_AUDIT"]

    def bank(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_open_deposit_and_balance(self):
        self.assertEqual(self.bank("open", "A1", "Ada")[0], 0)
        code, out, _ = self.bank("deposit", "A1", "12.5")
        self.assertEqual((code, json.loads(out)), (0, {"account": "A1", "balance": "12.50"}))
        self.assertEqual(self.bank("balance", "A1")[1], '{\n  "account": "A1",\n  "balance": "12.50",\n  "owner": "Ada"\n}\n')
        with open(self.log) as file:
            self.assertEqual(file.read(), "2024-03-01 open account=A1 owner=Ada\n2024-03-01 deposit account=A1 amount=12.50\n")

    def test_errors(self):
        self.assertEqual(self.bank("balance", "a1"), (2, "", "error: invalid account: a1\n"))
        self.assertEqual(self.bank("balance", "A1"), (1, "", "error: unknown account: A1\n"))
        self.bank("open", "A1", "Ada")
        self.assertEqual(self.bank("withdraw", "A1", "5"), (1, "", "error: not enough money in A1: 0.00\n"))
        self.assertEqual(self.bank("deposit", "A1", "1.234")[0], 2)

    def test_history(self):
        self.bank("open", "A1", "Ada")
        self.bank("open", "B2", "Bob")
        self.bank("deposit", "A1", "10")
        self.bank("transfer", "A1", "B2", "4")
        code, out, _ = self.bank("history", "A1")
        self.assertEqual(json.loads(out)["transactions"], [
            {"date": "2024-03-01", "kind": "deposit", "amount": "10.00"},
            {"date": "2024-03-01", "kind": "transfer", "amount": "-4.00", "to": "B2"},
        ])
        self.assertEqual(self.bank("history", "A1", "--from", "2024-03-02", "--to", "2024-03-01"), (2, "", "error: --from is after --to\n"))


if __name__ == "__main__":
    unittest.main()
