from billing.money import tax

STANDARD, REDUCED = 19, 7


def line_tax(cents, category):
    return tax(cents, REDUCED if category == "food" else STANDARD)
