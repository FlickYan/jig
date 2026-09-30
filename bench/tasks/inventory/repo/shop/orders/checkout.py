"""Turning a cart into an order."""
from shop.catalog.pricing import order_total
from shop.inventory.allocation import allocate
from shop.orders.discounts import apply_discount


def place_order(cart, stock, payments, discount_code=None):
    lines = cart.lines()
    total = apply_discount(order_total(lines), discount_code)
    allocate(stock, lines)
    payments.charge(cart.customer_id, total)
    return {"customer": cart.customer_id, "lines": lines, "total_cents": total}
