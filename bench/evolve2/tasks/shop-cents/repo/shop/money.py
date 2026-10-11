def dollars(amount):
    """An amount as the receipt shows it: $12.34, or -$5.00."""
    return f"-${-amount:.2f}" if amount < 0 else f"${amount:.2f}"
