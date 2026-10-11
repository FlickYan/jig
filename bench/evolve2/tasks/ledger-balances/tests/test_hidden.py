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

    def test_a_month_of_transactions(self):
        self.check([
            ('; The first month\n2024-01-01 Opening balance\n    assets:bank:checking    $1000.00\n    equity:opening\n\n2024-01-05 Grocery store\n    expenses:food           $45.20\n    assets:bank:checking    ; the rest\n\n2024-01-07 Exchange\n    assets:cash:eur         90 EUR\n    assets:bank:checking    $-100.00\n    expenses:fees           $1.50\n    equity:conversion       -90 EUR\n    equity:conversion       $98.50\n\n2024-01-10 Rent\n    expenses:rent           $800\n    assets:bank:checking    -$800 = $54.80\n', {'assets': {'$': Decimal('54.80'), 'EUR': Decimal('90')}, 'assets:bank': {'$': Decimal('54.80')}, 'assets:bank:checking': {'$': Decimal('54.80')}, 'assets:cash': {'EUR': Decimal('90')}, 'assets:cash:eur': {'EUR': Decimal('90')}, 'equity': {'$': Decimal('-901.50'), 'EUR': Decimal('-90')}, 'equity:conversion': {'$': Decimal('98.50'), 'EUR': Decimal('-90')}, 'equity:opening': {'$': Decimal('-1000.00')}, 'expenses': {'$': Decimal('846.70')}, 'expenses:fees': {'$': Decimal('1.50')}, 'expenses:food': {'$': Decimal('45.20')}, 'expenses:rent': {'$': Decimal('800')}}),
        ])

    def test_one_posting_without_an_amount_balances_every_commodity(self):
        self.check([
            ('2024-02-01 Split\n  assets:cash:eur  10 EUR\n  assets:bank  $20\n  equity:misc\n', {'assets': {'$': Decimal('20'), 'EUR': Decimal('10')}, 'assets:bank': {'$': Decimal('20')}, 'assets:cash': {'EUR': Decimal('10')}, 'assets:cash:eur': {'EUR': Decimal('10')}, 'equity': {'$': Decimal('-20'), 'EUR': Decimal('-10')}, 'equity:misc': {'$': Decimal('-20'), 'EUR': Decimal('-10')}}),
        ])

    def test_amounts(self):
        self.check([
            ('2024-03-01 Forms\n  a  $-5\n  b  -$5\n  c  $10\n  d  5 EUR\n  e  -2.5 AAPL\n  f  -5 EUR\n  g  2.5 AAPL\n', {'a': {'$': Decimal('-5')}, 'b': {'$': Decimal('-5')}, 'c': {'$': Decimal('10')}, 'd': {'EUR': Decimal('5')}, 'e': {'AAPL': Decimal('-2.5')}, 'f': {'EUR': Decimal('-5')}, 'g': {'AAPL': Decimal('2.5')}}),
            ('2024-03-02 Cents\n  a  $0.10\n  b  $0.20\n  c  $-0.30\n', {'a': {'$': Decimal('0.10')}, 'b': {'$': Decimal('0.20')}, 'c': {'$': Decimal('-0.30')}}),
        ])

    def test_comments_tabs_and_blank_lines(self):
        self.check([
            ('  ; an indented comment\n\n2024-04-01 Coffee; with milk\n\tassets:cash\t$-3.50  ; paid in cash\n\texpenses:coffee\n\n\n; done\n', {'assets': {'$': Decimal('-3.50')}, 'assets:cash': {'$': Decimal('-3.50')}, 'expenses': {'$': Decimal('3.50')}, 'expenses:coffee': {'$': Decimal('3.50')}}),
        ])

    def test_single_spaces_belong_to_the_name(self):
        self.check([
            ("2024-05-01 Float\n  assets:Petty Cash  $25\n  equity:Owner's Capital & Reserves\n", {'assets': {'$': Decimal('25')}, 'assets:Petty Cash': {'$': Decimal('25')}, 'equity': {'$': Decimal('-25')}, "equity:Owner's Capital & Reserves": {'$': Decimal('-25')}}),
        ])

    def test_parent_accounts_sum_their_own_and_their_children(self):
        self.check([
            ('2024-06-01 A\n  assets  $10\n  assets:bank  $5\n  assets:bank:savings  $1\n  income\n', {'assets': {'$': Decimal('16')}, 'assets:bank': {'$': Decimal('6')}, 'assets:bank:savings': {'$': Decimal('1')}, 'income': {'$': Decimal('-16')}}),
        ])

    def test_balances_that_come_to_zero(self):
        self.check([
            ('2024-07-01 In\n  assets:a  $10\n  income\n2024-07-02 Out\n  assets:b  $5\n  assets:a  $-10\n  income  $5\n', {'assets': {'$': Decimal('5')}, 'assets:a': {}, 'assets:b': {'$': Decimal('5')}, 'income': {'$': Decimal('-5')}}),
        ])

    def test_assertions_count_the_account_alone(self):
        self.check([
            ('2024-08-01 Deposit\n  assets:bank:checking  $500\n  income\n2024-08-02 Check\n  assets  $0 = $0\n  assets:bank  $0 = $0\n  assets:bank:checking  $-20 = $480\n  expenses\n2024-08-03 Euros\n  assets:bank:checking  10 EUR = 10 EUR\n  equity  -10 EUR\n', {'assets': {'$': Decimal('480'), 'EUR': Decimal('10')}, 'assets:bank': {'$': Decimal('480'), 'EUR': Decimal('10')}, 'assets:bank:checking': {'$': Decimal('480'), 'EUR': Decimal('10')}, 'equity': {'EUR': Decimal('-10')}, 'expenses': {'$': Decimal('20')}, 'income': {'$': Decimal('-500')}}),
        ])

    def test_an_empty_journal(self):
        self.check([
            ('', {}),
            ('; nothing yet\n\n', {}),
        ])

    def test_aliases(self):
        self.check([
            ('alias bank = assets:bank:checking\n2024-01-01 Opening\n    bank    $1000\n    equity:opening\n\n2024-01-03 Savings\n    bank:savings    $200\n    bank            $-200 = $800\n\nalias bank = assets:cash\n2024-01-04 Coffee\n    expenses:coffee   $5\n    bank\n', {'assets': {'$': Decimal('995')}, 'assets:bank': {'$': Decimal('1000')}, 'assets:bank:checking': {'$': Decimal('1000')}, 'assets:bank:checking:savings': {'$': Decimal('200')}, 'assets:cash': {'$': Decimal('-5')}, 'equity': {'$': Decimal('-1000')}, 'equity:opening': {'$': Decimal('-1000')}, 'expenses': {'$': Decimal('5')}, 'expenses:coffee': {'$': Decimal('5')}}),
            ('2024-01-01 Before\n    bank  $1\n    equity\nalias bank = assets:bank\n2024-01-02 After\n    bank  $2\n    equity\n', {'assets': {'$': Decimal('2')}, 'assets:bank': {'$': Decimal('2')}, 'bank': {'$': Decimal('1')}, 'equity': {'$': Decimal('-3')}}),
        ])

    def test_virtual_postings_dont_need_to_balance(self):
        self.check([
            ('2024-01-02 Groceries\n    expenses:food   $45\n    assets:cash\n    (budget:food)   $-45\n', {'assets': {'$': Decimal('-45')}, 'assets:cash': {'$': Decimal('-45')}, 'budget': {'$': Decimal('-45')}, 'budget:food': {'$': Decimal('-45')}, 'expenses': {'$': Decimal('45')}, 'expenses:food': {'$': Decimal('45')}}),
            ('2024-01-01 Budget only\n  (budget:food)  $100\n  (budget:rent)  $500\n', {'budget': {'$': Decimal('600')}, 'budget:food': {'$': Decimal('100')}, 'budget:rent': {'$': Decimal('500')}}),
        ])

    def test_total_assertions_include_subaccounts(self):
        self.check([
            ('2024-01-01 A\n  assets:bank  $955\n  assets:bank:savings  $200\n  equity\n2024-01-02 Check\n  assets  $0 == $1155\n  assets:bank  $0 = $955\n  assets:bank  $0 == $1155\n  equity  $0 == $-1155\n', {'assets': {'$': Decimal('1155')}, 'assets:bank': {'$': Decimal('1155')}, 'assets:bank:savings': {'$': Decimal('200')}, 'equity': {'$': Decimal('-1155')}}),
        ])

    def test_errors_name_their_line(self):
        for journal, line, why in [('2024-01-01 Off\n  a  $10\n  b  $-9\n', 1, "doesn't balance"), ('; header\n2024-01-01 Two missing\n  a  $10\n  b\n  c\n', 2, 'two postings without amounts'), ('2024-01-01 Alone\n  a  $10\n2024-01-02 B\n  a  $1\n  b\n', 1, 'one posting'), ('2024-02-30 Not a day\n  a  $1\n  b\n', 1, 'not a date'), ('  a  $1\n2024-01-01 X\n  b\n', 1, 'a posting before any transaction'), ('2024-01-01 X\n  a  $1\n  b\nsomething else\n', 4, 'not a transaction'), ('2024-01-01 X\n  a  $1.2.3\n  b\n', 2, 'not an amount'), ('2024-01-01 X\n  a  $1\n  b  10EUR\n', 3, 'a code needs a space'), ('2024-01-01 X\n  a  $1\n  b  10 eur\n', 3, 'codes are capitals'), ('2024-01-01 X\n  a  $ 1\n  b\n', 2, 'a space after $'), ('2024-01-01 X\n  assets:bank $10\n  b\n', 2, "one space: part of the name, and $ can't be"), ('2024-01-01 X\n  a  $10\n  b\n2024-01-02 Y\n  a  $5 = $16\n  b\n', 5, 'a failed assertion'), ('2024-1-01 X\n  a  $1\n  b\n', 1, 'a date needs two-digit months'), ('2024-01-01 X\n  a::b  $1\n  c\n', 2, 'an empty part'), ('alias bank\n', 1, 'an alias without a target'), ('2024-01-01 X\n  a  $1\n  b\nalias a:b = c\n', 4, 'an alias is one part'), ('2024-01-01 X\n  (a)\n  b  $1\n  c  $-1\n', 2, 'a virtual posting needs an amount'), ('2024-01-01 X\n  a  $5\n  b\n2024-01-02 Y\n  a  $1 == $7\n  b\n', 5, 'a failed total assertion'), ('2024-01-01 X\n  a  $5\n  (v)  $3\n', 1, 'one real posting and a virtual one'), ('2024-01-01 Empty\n2024-01-02 Y\n  a  $1\n  b\n', 1, 'no postings at all'), ('2024-01-01 X\n  a:b  $5\n  c\n2024-01-02 Y\n  a  $0 = $5\n  c  $0\n', 5, '= is the account alone')]:
            with self.subTest(why, journal=journal):
                with self.assertRaises(ValueError) as caught:
                    balances(journal)
                self.assertTrue(str(caught.exception).startswith(f"line {line}:"), str(caught.exception))


if __name__ == "__main__":
    unittest.main()
