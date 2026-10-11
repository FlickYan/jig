import unittest
from datetime import date, timedelta
from decimal import Decimal

from library.catalog import Catalog
from library.loans import Library, LoanError
from library.models import Book, Member

START = date(2024, 3, 1)  # loans from it are due on March 15


def library():
    catalog = Catalog([Book("111", "Dune", copies=2), Book("222", "Emma"), Book("333", "Ulysses"), Book("444", "Beloved")])
    return Library(catalog, [Member(1, "Maria"), Member(2, "Tom"), Member(3, "Ana", status="suspended")])


class TestIssues(unittest.TestCase):
    def fine_after(self, days_after_due):
        lib = library()
        lib.checkout(1, "111", START)
        return lib.return_book(1, "111", date(2024, 3, 15) + timedelta(days=days_after_due))

    def test_a_book_is_late_only_after_its_due_date(self):
        for days, expected in ((-5, "0"), (-1, "0"), (0, "0"), (1, "0.25"), (3, "0.75")):
            with self.subTest(days_after_due=days):
                self.assertEqual(self.fine_after(days), Decimal(expected))

    def test_fines_are_capped_at_five_dollars(self):
        for days, expected in ((19, "4.75"), (20, "5.00"), (21, "5.00"), (40, "5.00"), (365, "5.00")):
            with self.subTest(days_after_due=days):
                self.assertEqual(self.fine_after(days), Decimal(expected))

    def test_a_renewal_adds_to_the_due_date(self):
        lib = library()
        lib.checkout(1, "111", START)
        self.assertEqual(lib.renew(1, "111", date(2024, 3, 4)).due, date(2024, 3, 29))
        loan = lib.renew(1, "111", date(2024, 3, 29))  # on the due date: still allowed
        self.assertEqual((loan.due, loan.renewals), (date(2024, 4, 12), 2))
        with self.assertRaises(LoanError):
            lib.renew(1, "111", date(2024, 4, 1))  # renewed twice already

    def test_an_overdue_loan_still_cant_be_renewed(self):
        lib = library()
        lib.checkout(1, "111", START)
        with self.assertRaises(LoanError):
            lib.renew(1, "111", date(2024, 3, 16))
        self.assertEqual(lib.active_loans(1)[0].due, date(2024, 3, 15))

    def test_suspended_members_cant_check_out(self):
        lib = library()
        with self.assertRaises(LoanError):
            lib.checkout(3, "111", START)
        self.assertEqual(lib.available("111"), 2)

    def test_suspended_members_can_still_return_and_renew(self):
        lib = library()
        lib.checkout(2, "222", START)
        lib.checkout(2, "333", START)
        lib.members[2].status = "suspended"
        self.assertEqual(lib.renew(2, "222", date(2024, 3, 10)).due, date(2024, 3, 29))
        self.assertEqual(lib.return_book(2, "333", date(2024, 3, 17)), Decimal("0.50"))
        with self.assertRaises(LoanError):
            lib.checkout(2, "444", date(2024, 3, 17))


    def test_returned_books_dont_count_toward_the_limit(self):
        lib = library()
        for isbn in ("111", "222", "333"):
            lib.checkout(1, isbn, START)
        for isbn in ("111", "222", "333"):
            lib.return_book(1, isbn, date(2024, 3, 10))
        for isbn in ("444", "111", "222"):
            lib.checkout(1, isbn, date(2024, 4, 1))
        with self.assertRaises(LoanError):
            lib.checkout(1, "333", date(2024, 4, 1))

    def test_a_book_due_on_a_sunday_is_due_on_monday(self):
        lib = library()
        self.assertEqual(lib.checkout(1, "111", date(2024, 3, 3)).due, date(2024, 3, 18))  # borrowed on a Sunday
        self.assertEqual(lib.checkout(1, "222", date(2024, 3, 2)).due, date(2024, 3, 16))  # a Saturday stays
        self.assertEqual(lib.return_book(1, "111", date(2024, 3, 18)), Decimal("0"))
        self.assertEqual(lib.renew(1, "222", date(2024, 3, 16)).due, date(2024, 3, 30))


class TestUnchanged(unittest.TestCase):
    def test_three_books_at_most(self):
        lib = library()
        for isbn in ("111", "222", "333"):
            lib.checkout(1, isbn, START)
        with self.assertRaises(LoanError):
            lib.checkout(1, "444", START)
        lib.return_book(1, "222", date(2024, 3, 5))
        self.assertEqual(lib.checkout(1, "444", date(2024, 3, 5)).due, date(2024, 3, 19))

    def test_availability_and_returns(self):
        lib = library()
        lib.checkout(1, "111", START)
        lib.checkout(2, "111", START)
        self.assertEqual(lib.available("111"), 0)
        with self.assertRaises(LoanError):
            lib.checkout(1, "111", START)
        self.assertEqual(lib.return_book(2, "111", date(2024, 3, 14)), Decimal("0"))
        self.assertEqual(lib.available("111"), 1)
        with self.assertRaises(LoanError):
            lib.return_book(2, "111", date(2024, 3, 14))

    def test_a_returned_loan_cant_be_renewed(self):
        lib = library()
        lib.checkout(1, "222", START)
        lib.return_book(1, "222", date(2024, 3, 3))
        with self.assertRaises(LoanError):
            lib.renew(1, "222", date(2024, 3, 3))

    def test_fines_are_decimals(self):
        lib = library()
        lib.checkout(1, "111", START)
        self.assertIsInstance(lib.return_book(1, "111", date(2024, 3, 18)), Decimal)


if __name__ == "__main__":
    unittest.main()
