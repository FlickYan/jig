# Receipts are a cent off

Customers keep finding receipts a cent off. Tea with the HALF code came to $10.82, when half of $19.99
is $9.995, which is $10.00 off, and the total $10.81; three packs of cups came to $6.49 instead of
$6.50. The shop does its sums in floating point, and rounds them in more than one way.

Make the shop keep money in whole cents, as ints, everywhere: the prices in the catalog, each line's
total, and an order's `subtotal`, `discount`, `tax` and `total` (so `Order.tax` is an int number of
cents, and so on). Money is rounded in two places only, both to the nearest cent with halves rounded
up:

- the discount: the code's percentage of the subtotal;
- the tax: 8.25% of the subtotal less the discount.

The total is the subtotal less the discount, plus the tax. Receipts look exactly as they do now.

## Also needed

- **Lines are merged.** An order lists each product once, with its whole quantity, in the order the
  products first appear: tea x1 and later tea x2 make one line, `tea x3`.
- **Three for two on tea.** Every third tea in an order is free: the tea line shows the price of the
  teas paid for (`tea x3  $39.98`), and the subtotal counts only those.
- **SAVE15 needs $50.** SAVE15 takes 15% off only when the subtotal (after three for two) is at least
  $50.00; below that it takes nothing off. SAVE10 and HALF have no minimum. A receipt shows the
  discount line only when the discount isn't zero.
- **Shipping.** An order whose subtotal less the discount is under $35.00 pays $4.99 shipping, on a
  line `Shipping  $4.99` after the tax line; from $35.00 it ships free, with no shipping line.
  Shipping isn't taxed. `Order.shipping` is the fee in cents (0 when free), and the total includes it.
