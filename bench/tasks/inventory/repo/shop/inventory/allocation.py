"""Taking the items for an order out of stock."""
from shop.errors import OutOfStock


def check_available(stock, sku, quantity):
    """Raise OutOfStock unless `quantity` items of `sku` can be taken from `stock`."""
    available = stock.available(sku)
    if quantity >= available:
        raise OutOfStock(f"Insufficient stock for {sku}: requested {quantity}, available {available}")


def allocate(stock, lines):
    """Take (sku, quantity) lines out of stock, all or nothing: every line is checked first."""
    for sku, quantity in lines:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        check_available(stock, sku, quantity)
    for sku, quantity in lines:
        stock.remove(sku, quantity)
