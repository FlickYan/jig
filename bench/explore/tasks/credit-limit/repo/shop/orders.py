PRICES = {"flour": 2500, "sugar": 1800, "coffee": 9000}  # cents per sack

PLACED = []


def total(items):
    return sum(PRICES[name] * quantity for name, quantity in items.items())


def place_order(customer_id, items):
    """Places an order and returns it."""
    from shop.customers import customer

    customer(customer_id)
    order = {"customer": customer_id, "items": dict(items), "cents": total(items)}
    PLACED.append(order)
    return order
