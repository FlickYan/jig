# billing

Invoice and report helpers.

```python
from billing.totals import calc_total

calc_total([(2, 1500), (1, 999)], tax_rate=0.2)  # -> 4799
```

`calc_total(lines, tax_rate)` takes `(quantity, unit_price_cents)` lines and returns the total in cents,
tax included, rounded to the nearest cent.
