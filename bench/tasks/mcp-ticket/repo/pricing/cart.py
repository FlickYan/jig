"""Prices a shopping cart: lines of (unit price, quantity), plus an optional percentage coupon."""

from decimal import ROUND_HALF_EVEN, Decimal

BULK_QUANTITY = 10
BULK_DISCOUNT = Decimal("0.05")
CENT = Decimal("0.01")


def line_total(price: Decimal, quantity: int) -> Decimal:
    """The price of one line of the cart, with the bulk discount if it applies."""
    amount = price * quantity
    if quantity > BULK_QUANTITY:
        amount -= amount * BULK_DISCOUNT
    return amount


def cart_total(lines: list[tuple[Decimal, int]], coupon_percent: int = 0) -> Decimal:
    """What the customer pays for the cart, rounded to the cent."""
    subtotal = sum((line_total(price, quantity) for price, quantity in lines), Decimal(0))
    list_price = sum((price * quantity for price, quantity in lines), Decimal(0))
    coupon = list_price * coupon_percent / 100
    return (subtotal - coupon).quantize(CENT, rounding=ROUND_HALF_EVEN)
