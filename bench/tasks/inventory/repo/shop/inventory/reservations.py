"""Items held in customers' carts while they check out."""
from shop.errors import OutOfStock


class Reservations:
    def __init__(self, stock):
        self.stock = stock
        self.held = {}

    def free(self, sku):
        held = sum(quantity for (_, held_sku), quantity in self.held.items() if held_sku == sku)
        return self.stock.available(sku) - held

    def reserve(self, cart_id, sku, quantity):
        if quantity > self.free(sku):
            raise OutOfStock(f"Not enough stock to reserve {quantity} x {sku}")
        self.held[(cart_id, sku)] = self.held.get((cart_id, sku), 0) + quantity

    def release(self, cart_id):
        self.held = {key: q for key, q in self.held.items() if key[0] != cart_id}
