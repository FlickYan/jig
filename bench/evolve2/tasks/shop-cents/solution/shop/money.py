def dollars(cents):
    """An amount in cents as the receipt shows it: $12.34, or -$5.00."""
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}${cents // 100}.{cents % 100:02d}"
