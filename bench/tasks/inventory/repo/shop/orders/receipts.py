from shop.catalog.products import get_product
from shop.util.money import format_cents


def receipt(order):
    rows = [f"{quantity} x {get_product(sku).name}" for sku, quantity in order["lines"]]
    rows.append(f"Total: {format_cents(order['total_cents'])}")
    return "\n".join(rows)
