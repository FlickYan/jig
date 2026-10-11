from datetime import timedelta

from .fines import fine
from .members import can_borrow
from .models import Loan
from .policy import LOAN_DAYS, MAX_RENEWALS


def _open(day):
    """The library is closed on Sundays: a book due then is due the Monday after."""
    return day + timedelta(days=1) if day.weekday() == 6 else day


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
        if not can_borrow(member, len(self.active_loans(member_id=member_id))):
            raise LoanError(f"{member.name} can't check out another book")
        if self.available(isbn) < 1:
            raise LoanError(f"no copy of {isbn} is available")
        loan = Loan(member_id, isbn, today, _open(today + timedelta(days=LOAN_DAYS)))
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
        loan.due = _open(loan.due + timedelta(days=LOAN_DAYS))
        loan.renewals += 1
        return loan
