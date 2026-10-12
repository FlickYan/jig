"""Discounts, as rules: each looks at an order and returns the cents it takes off."""
from decimal import ROUND_HALF_UP, Decimal


def cents(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def coupon(order):
    """SAVE10 takes 10% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.10")) if order.coupon == "SAVE10" else 0


def bulk(order):
    """Bulk orders get 5% off."""
    units = sum(line.quantity for line in order.lines)
    return cents(Decimal(order.subtotal) * Decimal("0.05")) if units >= 10 else 0


def loyalty(order):
    """Customers in the loyalty programme get 2% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.02")) if order.loyal else 0


RULES = [coupon, bulk, loyalty]


def discount(order):
    """What all the rules take off the order, in cents."""
    return sum(rule(order) for rule in RULES)
