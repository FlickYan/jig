from shop import data


def outstanding(customer_id):
    """What the customer owes us now, in cents: their unpaid invoices."""
    return sum(entry["cents"] for entry in data.load("ledger").get(customer_id, []) if not entry["paid"])
