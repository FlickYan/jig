from billing.money import tax


def line_tax(cents, category):
    return 0 if category in ("food", "books") else tax(cents, 20)
