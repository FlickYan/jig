from datetime import date


def balance(entries):
    """The sum of the entries' amounts, in cents."""
    return sum(entry["cents"] for entry in entries)


def balance_by_account(entries):
    """Each account's balance, in cents."""
    totals = {}
    for entry in entries:
        totals[entry["account"]] = totals.get(entry["account"], 0) + entry["cents"]
    return totals
