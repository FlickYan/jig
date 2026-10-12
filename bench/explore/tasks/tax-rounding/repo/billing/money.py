def tax(cents, rate_percent):
    """The tax on an amount in cents, at a rate in percent, in cents."""
    return int(cents * rate_percent / 100)
