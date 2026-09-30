from billing import totals


def monthly_revenue(invoices):
    return sum(totals.calculate_total(inv["lines"], inv.get("tax_rate", 0.0)) for inv in invoices)


def largest_invoice(invoices):
    return max(invoices, key=lambda inv: totals.calculate_total(inv["lines"], inv.get("tax_rate", 0.0)))
