# billing

Invoice and report helpers.

```python
from billing.totals import calculate_total

calculate_total([(2, 1500), (1, 999)], tax_rate=0.2)  # -> 4799
```

`calculate_total(lines, tax_rate)` takes `(quantity, unit_price_cents)` lines and returns the total in cents,
tax included, rounded to the nearest cent. The old name, `calc_total`, still works but is deprecated.
