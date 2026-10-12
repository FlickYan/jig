from decimal import Decimal


def to_cents(price):
    return int((Decimal(str(price)) * 100).quantize(Decimal("1")))


def show(cents):
    return f"{cents // 100}.{cents % 100:02d}"
