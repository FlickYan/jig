from maketask import task

MODELS = '''
    from dataclasses import dataclass
    from datetime import date


    @dataclass
    class Book:
        isbn: str
        title: str
        copies: int = 1


    @dataclass
    class Member:
        id: int
        name: str
        status: str = "active"  # "active" or "suspended"


    @dataclass
    class Loan:
        member_id: int
        isbn: str
        borrowed: date
        due: date
        returned: date | None = None
        renewals: int = 0

        @property
        def active(self):
            return self.returned is None
'''
POLICY = '''
    from decimal import Decimal

    LOAN_DAYS = 14  # how long a loan, or a renewal, lasts
    MAX_LOANS = 3  # books a member may have out at once
    MAX_RENEWALS = 2
    FINE_PER_DAY = Decimal("0.25")  # for each day a book is returned late
    FINE_CAP = Decimal("5.00")  # the most a loan can be fined
'''
CATALOG = '''
    class Catalog:
        """The library's books, by ISBN."""

        def __init__(self, books=()):
            self.books = {book.isbn: book for book in books}

        def add(self, book):
            self.books[book.isbn] = book

        def get(self, isbn):
            if isbn not in self.books:
                raise KeyError(f"no book {isbn}")
            return self.books[isbn]
'''
MEMBERS_BUGGY = '''
    from .policy import MAX_LOANS


    def can_borrow(member, active_loans):
        """Whether the member may check out another book, with active_loans already out."""
        return active_loans < MAX_LOANS
'''
MEMBERS_FIXED = '''
    from .policy import MAX_LOANS


    def can_borrow(member, active_loans):
        """Whether the member may check out another book, with active_loans already out."""
        return member.status == "active" and active_loans < MAX_LOANS
'''
FINES_BUGGY = '''
    from .policy import FINE_CAP, FINE_PER_DAY


    def days_late(loan, returned_on):
        if returned_on < loan.due:
            return 0
        return (returned_on - loan.due).days + 1


    def fine(loan, returned_on):
        """What returning the loan on returned_on costs: a fine for each day late, up to the cap."""
        return min(days_late(loan, returned_on), FINE_CAP) * FINE_PER_DAY
'''
FINES_FIXED = '''
    from .policy import FINE_CAP, FINE_PER_DAY


    def days_late(loan, returned_on):
        return max(0, (returned_on - loan.due).days)


    def fine(loan, returned_on):
        """What returning the loan on returned_on costs: a fine for each day late, up to the cap."""
        return min(days_late(loan, returned_on) * FINE_PER_DAY, FINE_CAP)
'''
LOANS = '''
    from datetime import timedelta

    from .fines import fine
    from .members import can_borrow
    from .models import Loan
    from .policy import LOAN_DAYS, MAX_RENEWALS


    class LoanError(Exception):
        pass


    class Library:
        def __init__(self, catalog, members):
            self.catalog = catalog
            self.members = {member.id: member for member in members}
            self.loans = []

        def active_loans(self, member_id=None, isbn=None):
            return [
                loan for loan in self.loans
                if loan.active and (member_id is None or loan.member_id == member_id) and (isbn is None or loan.isbn == isbn)
            ]

        def available(self, isbn):
            """Copies of the book on the shelf."""
            return self.catalog.get(isbn).copies - len(self.active_loans(isbn=isbn))

        def checkout(self, member_id, isbn, today):
            member = self.members[member_id]
            if not can_borrow(member, COUNTED):
                raise LoanError(f"{member.name} can't check out another book")
            if self.available(isbn) < 1:
                raise LoanError(f"no copy of {isbn} is available")
            loan = Loan(member_id, isbn, today, CHECKOUT_DUE)
            self.loans.append(loan)
            return loan

        def _loan(self, member_id, isbn):
            for loan in self.active_loans(member_id, isbn):
                return loan
            raise LoanError(f"member {member_id} has no loan of {isbn}")

        def return_book(self, member_id, isbn, today):
            """Ends the loan, and returns its fine."""
            loan = self._loan(member_id, isbn)
            loan.returned = today
            return fine(loan, today)

        def renew(self, member_id, isbn, today):
            loan = self._loan(member_id, isbn)
            if today > loan.due:
                raise LoanError("an overdue loan can't be renewed")
            if loan.renewals >= MAX_RENEWALS:
                raise LoanError("the loan has been renewed too many times")
            loan.due = DUE
            loan.renewals += 1
            return loan
'''
ISSUE = '''
    # Problems the librarians reported

    1. **Returning a book on its due date costs a fine.** Maria returned *Dune* on the day it was due, and
       was charged $0.25. A book is late only after its due date.

    2. **Fines for very late books are too small.** A book returned 40 days late was fined $1.25. Fines are
       $0.25 a day, up to $5.00 for a loan, so that should have been $5.00.

    3. **Renewing early loses days.** A member who renewed a book three days after borrowing it got a due
       date 14 days after the renewal, 11 days sooner than it should be: a renewal adds 14 days to the
       loan's due date.

    4. **Suspended members can still borrow.** A member whose status is `suspended` checked out a book.
       Suspended members mustn't check out books, though they may still return and renew the ones they
       have.

    5. **Past loans count against the limit.** Ana borrowed three books in March and returned them all,
       and in April she couldn't check out a book: she was told she already had three. Only books a member
       still has count toward the three.

    6. **Books fall due on Sundays.** We're closed on Sundays, so a member can't return a book due then,
       and is fined for the Monday. A due date that would fall on a Sunday should be the Monday after.
'''
VISIBLE = '''
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
'''
HIDDEN = '''
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
'''

files = {
    "ISSUE.md": ISSUE,
    "library/__init__.py": '"""A small library\'s loans."""\n',
    "library/models.py": MODELS,
    "library/policy.py": POLICY,
    "library/catalog.py": CATALOG,
    "library/members.py": MEMBERS_BUGGY,
    "library/fines.py": FINES_BUGGY,
    "library/loans.py": LOANS.replace("CHECKOUT_DUE", "today + timedelta(days=LOAN_DAYS)").replace("COUNTED", "len([loan for loan in self.loans if loan.member_id == member_id])").replace("DUE", "today + timedelta(days=LOAN_DAYS)"),
    "tests/__init__.py": "",
    "tests/test_library.py": VISIBLE,
}
solution = {
    "library/members.py": MEMBERS_FIXED,
    "library/fines.py": FINES_FIXED,
    "library/loans.py": LOANS.replace("CHECKOUT_DUE", "_open(today + timedelta(days=LOAN_DAYS))").replace("COUNTED", "len(self.active_loans(member_id=member_id))").replace("DUE", "_open(loan.due + timedelta(days=LOAN_DAYS))").replace(
        "class LoanError(Exception):", "def _open(day):\n        \"\"\"The library is closed on Sundays: a book due then is due the Monday after.\"\"\"\n        return day + timedelta(days=1) if day.weekday() == 6 else day\n\n\n    class LoanError(Exception):"),
}
task(
    "library-issues",
    "The librarians reported the problems in ISSUE.md. Fix them in the library package, without changing anything else about how it behaves.",
    ["python", "bugs", "many files"],
    files,
    HIDDEN,
    solution,
)
