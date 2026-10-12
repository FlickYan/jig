PRICES = {"flour": 2500, "sugar": 1800, "coffee": 9000}  # cents per sack

PLACED = []


def total(items):
    return sum(PRICES[name] * quantity for name, quantity in items.items())


def place_order(customer_id, items):
    """Places an order and returns it, unless it would take the customer over their credit limit."""
    from shop.customers import credit_limit, customer
    from shop.errors import Refused
    from shop.ledger import outstanding

    customer(customer_id)
    cents = total(items)
    limit = credit_limit(customer_id)
    if limit is not None and outstanding(customer_id) + cents > limit:
        raise Refused(f"the order would take {customer_id} over their credit limit")
    order = {"customer": customer_id, "items": dict(items), "cents": cents}
    PLACED.append(order)
    return order
