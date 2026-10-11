from decimal import Decimal

LOAN_DAYS = 14  # how long a loan, or a renewal, lasts
MAX_LOANS = 3  # books a member may have out at once
MAX_RENEWALS = 2
FINE_PER_DAY = Decimal("0.25")  # for each day a book is returned late
FINE_CAP = Decimal("5.00")  # the most a loan can be fined
