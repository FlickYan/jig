"""Print last month's revenue. Usage: python3 scripts/monthly.py"""
from billing.reports import monthly_revenue
from billing.totals import calculate_total

EXAMPLE = [{"lines": [(1, 1000)], "tax_rate": 0.2}, {"lines": [(3, 250)]}]

if __name__ == "__main__":
    print("Revenue:", monthly_revenue(EXAMPLE))
    print("First invoice:", calculate_total(EXAMPLE[0]["lines"], 0.2))
