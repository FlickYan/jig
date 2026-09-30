from shop.errors import InvalidDiscount

CODES = {"WELCOME10": 10, "BREW20": 20}


def apply_discount(total_cents, code=None):
    """Total after a percentage discount code, rounded down to whole cents."""
    if code is None:
        return total_cents
    if code not in CODES:
        raise InvalidDiscount(f"Unknown discount code {code}")
    return total_cents * (100 - CODES[code]) // 100
