# Problems reported by the shop

1. **The supplier's file won't import.** This month's price list, which the supplier now exports from
   Excel, fails with `KeyError: 'sku'`. The file looks fine: it opens in Excel, and its first line is
   `sku,name,price` like last month's. A copy is in `examples/supplier-march.csv`.

2. **Price changes don't reach orders.** After we lowered the price of a product, orders still came to
   the old total, until we restarted the service. An order should always use the current price.

3. **The weekly report is out of order.** It listed the movements of 10/3/2024 before those of
   9/3/2024. It should list them in date order (and keep the order they were recorded in, for the same
   day).
