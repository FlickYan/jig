from billing.invoice import invoice_total


def monthly_total(invoices):
    """What the month's invoices add up to, in cents."""
    return sum(invoice_total(invoice) for invoice in invoices)
