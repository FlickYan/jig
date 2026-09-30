"""Restocking from suppliers."""

REORDER_LEVEL = 5
REORDER_AMOUNT = 20


def restock(stock, skus):
    """Top up every SKU that has fallen to the reorder level. Returns the SKUs reordered."""
    reordered = []
    for sku in skus:
        if stock.available(sku) <= REORDER_LEVEL:
            stock.add(sku, REORDER_AMOUNT)
            reordered.append(sku)
    return reordered
