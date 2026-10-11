RATE_BASIS_POINTS = 825  # 8.25%


def tax(amount):
    """The tax, in cents, on an amount in cents: rounded to the nearest cent, halves up."""
    return (amount * RATE_BASIS_POINTS + 5000) // 10000
