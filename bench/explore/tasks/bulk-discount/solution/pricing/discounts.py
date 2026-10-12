"""Discounts, as rules: each looks at an order and returns the cents it takes off."""
from decimal import ROUND_HALF_UP, Decimal


def cents(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def coupon(order):
    """SAVE10 takes 10% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.10")) if order.coupon == "SAVE10" else 0


# Bulk tiers, as before 2.0: (minimum units in the order, rate). The largest tier that applies wins.
TIERS = [(200, Decimal("0.12")), (50, Decimal("0.08")), (10, Decimal("0.05"))]
BULK_CAP = 15000  # cents: no order gets more than 150.00 off for its size


def bulk(order):
    """Bulk orders get 5%, 8% or 12% off by size, at most 150.00."""
    units = sum(line.quantity for line in order.lines)
    for minimum, rate in TIERS:
        if units >= minimum:
            return min(cents(Decimal(order.subtotal) * rate), BULK_CAP)
    return 0


def loyalty(order):
    """Customers in the loyalty programme get 2% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.02")) if order.loyal else 0


RULES = [coupon, bulk, loyalty]


def discount(order):
    """What all the rules take off the order, in cents."""
    return sum(rule(order) for rule in RULES)
