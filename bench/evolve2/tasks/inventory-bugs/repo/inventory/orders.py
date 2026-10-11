from .pricing import unit_price


def order_total(lines):
    """The total, in cents, of order lines (sku, quantity)."""
    return sum(unit_price(sku) * quantity for sku, quantity in lines)
