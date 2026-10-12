from shop import data
from shop.errors import NotFound


def customer(customer_id):
    customers = data.load("customers")
    if customer_id not in customers:
        raise NotFound(f"no customer {customer_id}")
    return customers[customer_id]


def credit_limit(customer_id):
    """How much the customer may owe us in all, in cents; None for no limit. An override in
    credit_overrides.json wins over the customer's own limit; trusted customers have no limit."""
    record = customer(customer_id)
    if record.get("trusted"):
        return None
    overrides = data.load("credit_overrides")
    return overrides.get(customer_id, record["limit"])
