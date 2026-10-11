from .policy import FINE_CAP, FINE_PER_DAY


def days_late(loan, returned_on):
    if returned_on < loan.due:
        return 0
    return (returned_on - loan.due).days + 1


def fine(loan, returned_on):
    """What returning the loan on returned_on costs: a fine for each day late, up to the cap."""
    return min(days_late(loan, returned_on), FINE_CAP) * FINE_PER_DAY
