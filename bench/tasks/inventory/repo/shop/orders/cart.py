from shop.catalog.products import get_product


class Cart:
    def __init__(self, customer_id):
        self.customer_id = customer_id
        self._quantities = {}

    def add(self, sku, quantity=1):
        get_product(sku)  # unknown products fail early
        self._quantities[sku] = self._quantities.get(sku, 0) + quantity

    def remove(self, sku):
        self._quantities.pop(sku, None)

    def lines(self):
        """(sku, quantity) pairs in the order they were first added."""
        return list(self._quantities.items())
