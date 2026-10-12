def fetch_report(transport, month):
    """The sales report for a month (YYYY-MM)."""
    return transport.get(f"/reports/sales/{month}")
