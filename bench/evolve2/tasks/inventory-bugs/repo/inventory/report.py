def weekly_report(stock):
    """The week's movements, one line each, in date order: "D/M/YYYY sku quantity"."""
    lines = []
    for movement in sorted(stock.movements, key=lambda m: m.date):
        lines.append(f"{movement.date} {movement.sku} {movement.quantity:+d}")
    return "\n".join(lines)
