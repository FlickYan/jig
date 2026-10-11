from .policy import MAX_LOANS


def can_borrow(member, active_loans):
    """Whether the member may check out another book, with active_loans already out."""
    return active_loans < MAX_LOANS
