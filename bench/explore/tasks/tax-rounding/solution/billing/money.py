from decimal import ROUND_HALF_UP, Decimal


def tax(cents, rate_percent):
    """The tax on an amount in cents, at a rate in percent, in cents, rounded half away from zero."""
    exact = Decimal(cents) * Decimal(str(rate_percent)) / 100
    return int(exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
