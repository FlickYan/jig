import csv
from decimal import Decimal


def to_cents(price):
    return int((Decimal(price) * 100).quantize(Decimal("1")))


def import_prices(path):
    """The supplier's price list as {sku: (name, cents, currency)}. Lines starting with # and blank
    lines are skipped; spaces around fields don't count. Fields may be quoted, as in CSV."""
    prices = {}
    with open(path, encoding="utf-8", newline="") as f:
        lines = (line for line in f if line.strip() and not line.strip().startswith("#"))
        for row in csv.reader(lines, skipinitialspace=True):
            sku, name, price, currency = [field.strip() for field in row]
            prices[sku] = (name, to_cents(price), currency.upper())
    return prices
