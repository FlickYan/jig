import unittest
from datetime import date
from decimal import Decimal

from library.catalog import Catalog
from library.loans import Library, LoanError
from library.models import Book, Member


def library():
    catalog = Catalog([Book("111", "Dune", copies=2), Book("222", "Emma")])
    return Library(catalog, [Member(1, "Maria"), Member(2, "Tom")])


class TestLoans(unittest.TestCase):
    def test_checkout_and_return(self):
        lib = library()
        loan = lib.checkout(1, "111", date(2024, 3, 1))
        self.assertEqual(loan.due, date(2024, 3, 15))
        self.assertEqual(lib.available("111"), 1)
        self.assertEqual(lib.return_book(1, "111", date(2024, 3, 10)), Decimal("0"))
        self.assertEqual(lib.available("111"), 2)

    def test_no_copy_left(self):
        lib = library()
        lib.checkout(1, "222", date(2024, 3, 1))
        with self.assertRaises(LoanError):
            lib.checkout(2, "222", date(2024, 3, 2))

    def test_late_return(self):
        lib = library()
        lib.checkout(1, "111", date(2024, 3, 1))
        self.assertEqual(lib.return_book(1, "111", date(2024, 3, 20)), Decimal("1.25"))


if __name__ == "__main__":
    unittest.main()
