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
