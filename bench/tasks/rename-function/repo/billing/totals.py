def calc_total(lines, tax_rate=0.0):
    """Total in cents of (quantity, unit_price_cents) lines, tax included, rounded to the nearest cent."""
    subtotal = sum(quantity * price for quantity, price in lines)
    return round(subtotal * (1 + tax_rate))
