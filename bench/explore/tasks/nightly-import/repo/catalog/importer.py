from decimal import Decimal


def to_cents(price):
    return int((Decimal(price) * 100).quantize(Decimal("1")))


def import_prices(path):
    """The supplier's price list as {sku: (name, cents, currency)}. Lines starting with # and blank
    lines are skipped; spaces around fields don't count."""
    prices = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            sku, name, price, currency = [field.strip() for field in line.split(",")]
            prices[sku] = (name, to_cents(price), currency.upper())
    return prices
