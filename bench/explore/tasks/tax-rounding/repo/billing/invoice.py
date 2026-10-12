from billing.regions import plugin


def invoice_total(invoice):
    """Net plus tax, in cents: each line's tax by the customer's region."""
    rules = plugin(invoice["region"])
    return sum(line["cents"] + rules.line_tax(line["cents"], line["category"]) for line in invoice["lines"])
