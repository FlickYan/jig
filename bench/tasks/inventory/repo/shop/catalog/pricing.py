from shop.catalog.products import get_product


def line_total(sku, quantity):
    return get_product(sku).price_cents * quantity


def order_total(lines):
    """Total in cents for (sku, quantity) lines, before discounts."""
    return sum(line_total(sku, quantity) for sku, quantity in lines)
