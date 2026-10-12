# Money

- Amounts are kept in whole cents (int) everywhere.
- Tax is computed per invoice line and rounded to the nearest cent, halves away from zero
  (12.5 cents is 13 cents, -12.5 is -13).
- Totals are sums of rounded line amounts: never round a sum again.
