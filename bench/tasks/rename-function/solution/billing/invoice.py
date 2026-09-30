from billing.totals import calculate_total


def invoice(customer, lines, tax_rate):
    return {"customer": customer, "lines": lines, "total": calculate_total(lines, tax_rate)}
