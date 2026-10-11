CODES = {"SAVE10": 10, "SAVE15": 15, "HALF": 50}  # percent off the subtotal


def discount(subtotal, code):
    if code is None:
        return 0.0
    if code not in CODES:
        raise ValueError(f"unknown discount code: {code}")
    return round(subtotal * CODES[code] / 100, 2)
