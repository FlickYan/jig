CODES = {"SAVE10": 10, "SAVE15": 15, "HALF": 50}  # percent off the subtotal
MINIMUM = {"SAVE15": 5000}  # the subtotal, in cents, a code needs to take anything off


def discount(subtotal, code):
    """The discount, in cents, on a subtotal in cents: rounded to the nearest cent, halves up."""
    if code is None:
        return 0
    if code not in CODES:
        raise ValueError(f"unknown discount code: {code}")
    if subtotal < MINIMUM.get(code, 0):
        return 0
    return (subtotal * CODES[code] + 50) // 100
