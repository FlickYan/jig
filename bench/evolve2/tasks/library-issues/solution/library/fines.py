from .policy import FINE_CAP, FINE_PER_DAY


def days_late(loan, returned_on):
    return max(0, (returned_on - loan.due).days)


def fine(loan, returned_on):
    """What returning the loan on returned_on costs: a fine for each day late, up to the cap."""
    return min(days_late(loan, returned_on) * FINE_PER_DAY, FINE_CAP)
