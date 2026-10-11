import contextlib, io, json, os, pathlib, sys, tempfile, textwrap, types
from maketask import task

B = pathlib.Path("bank")
CLI = (B / "cli.py").read_text()
PARSER = '''command = commands.add_parser("statement", help="an account's statement for a month")
    command.add_argument("account")
    command.add_argument("--month", required=True, help="YYYY-MM")'''
FUNCTION = '''

def statement(store, args):
    check_id(args.account)
    if not re.fullmatch(r"\\d{4}-(0[1-9]|1[0-2])", args.month):
        raise ValueError(f"invalid month: {args.month} (use YYYY-MM)")
    record = store.account(args.account)
    opening = sum(t["amount"] for t in record["transactions"] if t["date"][:7] < args.month)
    balance_after, transactions = opening, []
    for transaction in record["transactions"]:
        if transaction["date"][:7] == args.month:
            balance_after += transaction["amount"]
            transactions.append({**shown(transaction), "balance": format_amount(balance_after)})
    return emit({
        "account": args.account,
        "month": args.month,
        "opening_balance": format_amount(opening),
        "transactions": transactions,
        "closing_balance": format_amount(balance_after),
    })

'''
start_cli = CLI.replace("    STATEMENT_PARSER\n", "").replace("STATEMENT_FUNCTION\n", "\n").replace(" STATEMENT_COMMAND", "")
solved_cli = CLI.replace("STATEMENT_PARSER", PARSER).replace("STATEMENT_FUNCTION\n", FUNCTION).replace(" STATEMENT_COMMAND", ', "statement": statement').replace('import argparse\n', 'import argparse\nimport re\n')
helpers = {name: (B / f"{name}.py").read_text() for name in ("money", "dates", "output", "audit", "store")}

# Load the solved package to compute the expected outputs.
work = tempfile.mkdtemp()
(pathlib.Path(work) / "bank").mkdir()
for name, text in {**helpers, "cli": solved_cli, "__init__": ""}.items():
    (pathlib.Path(work) / "bank" / f"{name}.py").write_text(text)
sys.path.insert(0, work)
from bank.cli import main  # noqa: E402

def run(env, *argv):
    os.environ.update(env)
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = main(list(argv))
        except SystemExit as exit_:
            code = exit_.code
    return code, out.getvalue(), err.getvalue()

HISTORY = [
    ("2024-02-10", "open", "A1", "Ada"), ("2024-02-10", "deposit", "A1", "100.00"), ("2024-02-25", "withdraw", "A1", "20.50"),
    ("2024-02-26", "open", "B2", "Bob"), ("2024-03-01", "deposit", "B2", "50"), ("2024-03-05", "transfer", "A1", "B2", "30.00"),
    ("2024-03-31", "deposit", "A1", "5.25"), ("2024-04-01", "withdraw", "A1", "10"), ("2024-04-01", "open", "C3", "Cy"),
]
db, log = os.path.join(work, "bank.json"), os.path.join(work, "audit.log")
env = {"BANK_DB": db, "BANK_AUDIT": log}
for day, *argv in HISTORY:
    assert run({**env, "BANK_TODAY": day}, *argv)[0] == 0, argv
STATEMENTS = [("A1", "2024-03"), ("B2", "2024-03"), ("A1", "2024-02"), ("A1", "2024-01"), ("A1", "2024-05"), ("C3", "2024-04"), ("B2", "2024-04")]
EXPECTED = [(account, month, run(env, "statement", account, "--month", month)) for account, month in STATEMENTS]
ERRORS = [("a1", "2024-03"), ("A9", "2024-03"), ("A1", "2024-3"), ("A1", "2024-13"), ("A1", "24-03"), ("A1", "2024-00"), ("1", "2024-03")]
EXPECTED_ERRORS = [(account, month, run(env, "statement", account, "--month", month)) for account, month in ERRORS]
for row in EXPECTED[:2] + EXPECTED_ERRORS[:3]:
    print(row)

HIDDEN = '''
import contextlib
import io
import os
import tempfile
import unittest

from bank.cli import main

HISTORY = ''' + repr(HISTORY) + '''
EXPECTED = ''' + repr(EXPECTED) + '''
EXPECTED_ERRORS = ''' + repr(EXPECTED_ERRORS) + '''


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
'''

VISIBLE = '''
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
        self.assertEqual(self.bank("balance", "A1")[1], '{\\n  "account": "A1",\\n  "balance": "12.50",\\n  "owner": "Ada"\\n}\\n')
        with open(self.log) as file:
            self.assertEqual(file.read(), "2024-03-01 open account=A1 owner=Ada\\n2024-03-01 deposit account=A1 amount=12.50\\n")

    def test_errors(self):
        self.assertEqual(self.bank("balance", "a1"), (2, "", "error: invalid account: a1\\n"))
        self.assertEqual(self.bank("balance", "A1"), (1, "", "error: unknown account: A1\\n"))
        self.bank("open", "A1", "Ada")
        self.assertEqual(self.bank("withdraw", "A1", "5"), (1, "", "error: not enough money in A1: 0.00\\n"))
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
        self.assertEqual(self.bank("history", "A1", "--from", "2024-03-02", "--to", "2024-03-01"), (2, "", "error: --from is after --to\\n"))


if __name__ == "__main__":
    unittest.main()
'''

files = {
    "README.md": '''
        # bank

        A small bank's accounts, from the command line.

        ```
        python -m bank open ACCOUNT OWNER
        python -m bank deposit ACCOUNT AMOUNT
        python -m bank withdraw ACCOUNT AMOUNT
        python -m bank transfer SOURCE TARGET AMOUNT
        python -m bank balance ACCOUNT
        python -m bank history ACCOUNT [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--kind KIND]
        ```

        Accounts are kept in `BANK_DB` (default `bank.json`), and changes are logged to `BANK_AUDIT`.
    ''',
    "TASK.md": '''
        # bank statement

        Add a command, `bank statement ACCOUNT --month YYYY-MM`, that shows an account's statement for a
        month, with these fields:

        - `account` and `month`, as given;
        - `opening_balance`: the account's balance at the start of the month;
        - `transactions`: the account's transactions in that month, in the order they were made, each as
          `bank history` shows it, with one more field, `balance`: the account's balance after it;
        - `closing_balance`: the balance at the end of the month.

        A month that isn't written `YYYY-MM`, or isn't a real month, is an error: `invalid month: <what was
        given> (use YYYY-MM)`. In every other way, the command should work like the others: the same kind of
        arguments, checks, errors, exit codes, output and logging.
    ''',
    "bank/__init__.py": "\"\"\"A small bank's accounts.\"\"\"\n",
    "bank/__main__.py": "from .cli import main\n\nraise SystemExit(main())\n",
    "bank/cli.py": start_cli,
    **{f"bank/{name}.py": text for name, text in helpers.items()},
    "tests/__init__.py": "",
    "tests/test_cli.py": VISIBLE,
}
task(
    "bank-statement",
    "Add the statement command that TASK.md describes to the bank command-line tool.",
    ["python", "feature", "conventions", "many files"],
    files,
    HIDDEN,
    {"bank/cli.py": solved_cli},
)
