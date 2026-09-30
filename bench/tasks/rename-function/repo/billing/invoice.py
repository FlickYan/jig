from billing.totals import calc_total


def invoice(customer, lines, tax_rate):
    return {"customer": customer, "lines": lines, "total": calc_total(lines, tax_rate)}
