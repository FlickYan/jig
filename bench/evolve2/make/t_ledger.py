import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("l", "ledger_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

MAIN = """; The first month
2024-01-01 Opening balance
    assets:bank:checking    $1000.00
    equity:opening

2024-01-05 Grocery store
    expenses:food           $45.20
    assets:bank:checking    ; the rest

2024-01-07 Exchange
    assets:cash:eur         90 EUR
    assets:bank:checking    $-100.00
    expenses:fees           $1.50
    equity:conversion       -90 EUR
    equity:conversion       $98.50

2024-01-10 Rent
    expenses:rent           $800
    assets:bank:checking    -$800 = $54.80
"""
VALID = {
    "test_a_month_of_transactions": [MAIN],
    "test_one_posting_without_an_amount_balances_every_commodity": ["2024-02-01 Split\n  assets:cash:eur  10 EUR\n  assets:bank  $20\n  equity:misc\n"],
    "test_amounts": ["2024-03-01 Forms\n  a  $-5\n  b  -$5\n  c  $10\n  d  5 EUR\n  e  -2.5 AAPL\n  f  -5 EUR\n  g  2.5 AAPL\n", "2024-03-02 Cents\n  a  $0.10\n  b  $0.20\n  c  $-0.30\n"],
    "test_comments_tabs_and_blank_lines": ["  ; an indented comment\n\n2024-04-01 Coffee; with milk\n\tassets:cash\t$-3.50  ; paid in cash\n\texpenses:coffee\n\n\n; done\n"],
    "test_single_spaces_belong_to_the_name": ["2024-05-01 Float\n  assets:Petty Cash  $25\n  equity:Owner's Capital & Reserves\n"],
    "test_parent_accounts_sum_their_own_and_their_children": ["2024-06-01 A\n  assets  $10\n  assets:bank  $5\n  assets:bank:savings  $1\n  income\n"],
    "test_balances_that_come_to_zero": ["2024-07-01 In\n  assets:a  $10\n  income\n2024-07-02 Out\n  assets:b  $5\n  assets:a  $-10\n  income  $5\n"],
    "test_assertions_count_the_account_alone": ["2024-08-01 Deposit\n  assets:bank:checking  $500\n  income\n2024-08-02 Check\n  assets  $0 = $0\n  assets:bank  $0 = $0\n  assets:bank:checking  $-20 = $480\n  expenses\n2024-08-03 Euros\n  assets:bank:checking  10 EUR = 10 EUR\n  equity  -10 EUR\n"],
    "test_an_empty_journal": ["", "; nothing yet\n\n"],
    "test_aliases": ["alias bank = assets:bank:checking\n2024-01-01 Opening\n    bank    $1000\n    equity:opening\n\n2024-01-03 Savings\n    bank:savings    $200\n    bank            $-200 = $800\n\nalias bank = assets:cash\n2024-01-04 Coffee\n    expenses:coffee   $5\n    bank\n",
                     "2024-01-01 Before\n    bank  $1\n    equity\nalias bank = assets:bank\n2024-01-02 After\n    bank  $2\n    equity\n"],
    "test_virtual_postings_dont_need_to_balance": ["2024-01-02 Groceries\n    expenses:food   $45\n    assets:cash\n    (budget:food)   $-45\n", "2024-01-01 Budget only\n  (budget:food)  $100\n  (budget:rent)  $500\n"],
    "test_total_assertions_include_subaccounts": ["2024-01-01 A\n  assets:bank  $955\n  assets:bank:savings  $200\n  equity\n2024-01-02 Check\n  assets  $0 == $1155\n  assets:bank  $0 = $955\n  assets:bank  $0 == $1155\n  equity  $0 == $-1155\n"],
}
ERRORS = [
    ("2024-01-01 Off\n  a  $10\n  b  $-9\n", 1, "doesn't balance"),
    ("; header\n2024-01-01 Two missing\n  a  $10\n  b\n  c\n", 2, "two postings without amounts"),
    ("2024-01-01 Alone\n  a  $10\n2024-01-02 B\n  a  $1\n  b\n", 1, "one posting"),
    ("2024-02-30 Not a day\n  a  $1\n  b\n", 1, "not a date"),
    ("  a  $1\n2024-01-01 X\n  b\n", 1, "a posting before any transaction"),
    ("2024-01-01 X\n  a  $1\n  b\nsomething else\n", 4, "not a transaction"),
    ("2024-01-01 X\n  a  $1.2.3\n  b\n", 2, "not an amount"),
    ("2024-01-01 X\n  a  $1\n  b  10EUR\n", 3, "a code needs a space"),
    ("2024-01-01 X\n  a  $1\n  b  10 eur\n", 3, "codes are capitals"),
    ("2024-01-01 X\n  a  $ 1\n  b\n", 2, "a space after $"),
    ("2024-01-01 X\n  assets:bank $10\n  b\n", 2, "one space: part of the name, and $ can't be"),
    ("2024-01-01 X\n  a  $10\n  b\n2024-01-02 Y\n  a  $5 = $16\n  b\n", 5, "a failed assertion"),
    ("2024-1-01 X\n  a  $1\n  b\n", 1, "a date needs two-digit months"),
    ("2024-01-01 X\n  a::b  $1\n  c\n", 2, "an empty part"),
    ("alias bank\n", 1, "an alias without a target"),
    ("2024-01-01 X\n  a  $1\n  b\nalias a:b = c\n", 4, "an alias is one part"),
    ("2024-01-01 X\n  (a)\n  b  $1\n  c  $-1\n", 2, "a virtual posting needs an amount"),
    ("2024-01-01 X\n  a  $5\n  b\n2024-01-02 Y\n  a  $1 == $7\n  b\n", 5, "a failed total assertion"),
    ("2024-01-01 X\n  a  $5\n  (v)  $3\n", 1, "one real posting and a virtual one"),
    ("2024-01-01 Empty\n2024-01-02 Y\n  a  $1\n  b\n", 1, "no postings at all"),
    ("2024-01-01 X\n  a:b  $5\n  c\n2024-01-02 Y\n  a  $0 = $5\n  c  $0\n", 5, "= is the account alone"),
]
for journal, line, why in ERRORS:
    try:
        m.balances(journal); raise SystemExit(f"accepted: {why}")
    except ValueError as error:
        assert str(error).startswith(f"line {line}:"), (why, str(error))

def literal(result):
    return "{" + ", ".join(f"{a!r}: {{" + ", ".join(f"{c!r}: Decimal({str(q)!r})" for c, q in sorted(amounts.items())) + "}" for a, amounts in sorted(result.items())) + "}"

methods = []
for method, journals in VALID.items():
    body = "\n".join(f"            ({j!r}, {literal(m.balances(j))})," for j in journals)
    methods.append(f"    def {method}(self):\n        self.check([\n{body}\n        ])\n")

hidden = '''
import unittest
from decimal import Decimal

from ledger import balances


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for journal, expected in cases:
            with self.subTest(journal=journal):
                result = balances(journal)
                self.assertEqual(result, expected)
                for amounts in result.values():
                    for quantity in amounts.values():
                        self.assertIsInstance(quantity, Decimal)

''' + "\n".join(methods) + f'''
    def test_errors_name_their_line(self):
        for journal, line, why in {ERRORS!r}:
            with self.subTest(why, journal=journal):
                with self.assertRaises(ValueError) as caught:
                    balances(journal)
                self.assertTrue(str(caught.exception).startswith(f"line {{line}}:"), str(caught.exception))


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
# balances(journal) -> dict

The balance of every account in a double-entry journal, written in a small plain-text format. The
result maps each account to a dict of its balances, `{commodity: Decimal}`.

## The journal

1. Lines end with `\n`. A blank line, or one whose first character other than spaces and tabs is `;`, is
   ignored.
2. A transaction starts with a line, not indented, of a date `YYYY-MM-DD` (a real date), then
   optionally a space and a description, which may be anything.
3. Its postings follow, each on an indented line (starting with spaces or a tab): an account, then at
   least two spaces or a tab, then an amount; or just an account, without an amount. On a posting line,
   everything from a `;` on is a comment.
4. An account name is one or more parts separated by `:` (`assets:bank:checking`). A part is made of
   letters, digits and `-`, `_`, `'`, `&`, `.`, with single spaces between words (`assets:Petty Cash`).
   So a single space before an amount makes it part of the name, which the name's characters then rule
   out.
5. An amount is a quantity and a commodity: dollars, written with `$` before the number (`$45.20`,
   `-$5` or `$-5`), or a code of capital letters after it, after one space (`10 EUR`, `-2.5 AAPL`). The
   quantity is digits, optionally with `.` and more digits after it, and optionally a `-` before it (or
   before the `$`). Quantities are exact decimals. The commodity of dollar amounts is `"$"`.
6. A balance assertion may follow a posting's amount: ` = ` and an amount (`assets:bank  $-20 = $480`).
   After that posting, the account's own balance in the assertion's commodity (its own postings only,
   not its children's) must be exactly that amount.

## Balancing

7. A transaction needs at least two postings that aren't virtual (rule 12), except that a transaction
   whose postings are all virtual needs only one; so a transaction with no postings is invalid. In each,
   the amounts of each commodity, except those of virtual postings, must add up to zero. At most one
   posting may leave out its amount: it takes, for every commodity whose amounts don't add up to zero, the
   amount that balances it (one posting can balance dollars and euros at once).
8. Transactions apply in the order they are written, so an assertion sees every posting written before
   it.
9. Anything wrong raises `ValueError`, with a message that starts with `line N:`, where N is the line's
   number (counting from 1): the date line of a transaction that doesn't balance (rule 7), and otherwise
   the line with the problem (a malformed line, a posting before any transaction, or the posting whose
   assertion fails).

## Balances

10. Every account that has a posting is in the result, and so is every account above it (`assets` and
    `assets:bank` for `assets:bank:checking`). An account's balance is the sum of its own postings and
    of those of all the accounts below it, per commodity. A commodity whose balance is zero is left out
    of an account's dict, which may then be empty.

## More

11. An alias is a line, not indented and outside any transaction, `alias <name> = <account>`, where the
    name is a single part of an account name (rule 4) and the account is an account name. From that line
    on, a posting whose account's first part is the name has it replaced by the account
    (`bank:savings` is `assets:bank:checking:savings` after `alias bank = assets:bank:checking`). An
    alias given again replaces the old one, and the account an alias stands for is taken as written,
    with no alias applied to it. A malformed alias line raises `ValueError` (rule 9).
12. A posting whose account is in parentheses, `(budget:food)  $-45`, is virtual: its amount counts in
    the balances and in assertions like any other's, but not in balancing its transaction (rule 7). A
    virtual posting must have an amount.
13. A total assertion, ` == ` and an amount after a posting's amount, is like a balance assertion (rule
    6), but for the account's balance together with those of all the accounts below it.
'''

task(
    "ledger-balances",
    "Implement balances in ledger.py so that it follows SPEC.md exactly.",
    ["python", "spec", "money"],
    {
        "SPEC.md": SPEC,
        "ledger.py": '''
            def balances(journal):
                """Every account's balances in a plain-text double-entry journal. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_ledger.py": '''
            import unittest
            from decimal import Decimal

            from ledger import balances


            class TestBasics(unittest.TestCase):
                def test_one_transaction(self):
                    journal = "2024-01-01 Coffee\\n    expenses:coffee  $3.50\\n    assets:cash\\n"
                    self.assertEqual(balances(journal), {
                        "expenses": {"$": Decimal("3.50")}, "expenses:coffee": {"$": Decimal("3.50")},
                        "assets": {"$": Decimal("-3.50")}, "assets:cash": {"$": Decimal("-3.50")},
                    })

                def test_unbalanced(self):
                    with self.assertRaises(ValueError):
                        balances("2024-01-01 Oops\\n    a  $1\\n    b  $2\\n")


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"ledger.py": open("ledger_solution.py").read()},
)
