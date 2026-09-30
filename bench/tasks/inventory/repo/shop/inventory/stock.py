class Stock:
    """How many of each SKU the warehouse has on hand."""

    def __init__(self, levels=None):
        self._levels = dict(levels or {})

    def available(self, sku):
        return self._levels.get(sku, 0)

    def add(self, sku, quantity):
        self._levels[sku] = self.available(sku) + quantity

    def remove(self, sku, quantity):
        self._levels[sku] = self.available(sku) - quantity
