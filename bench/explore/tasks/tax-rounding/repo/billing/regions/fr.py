from billing.money import tax

RATES = {"food": 5.5, "books": 5.5, "default": 20}


def line_tax(cents, category):
    return tax(cents, RATES.get(category, RATES["default"]))
