from .catalog import price
from .discounts import discount
from .money import dollars
from .tax import tax

FREE_SHIPPING_FROM = 3500  # cents, after the discount
SHIPPING = 499


class Order:
    def __init__(self, items, code=None):
        """items: (sku, quantity) pairs. Lines of the same product are merged, in the order they first appear."""
        quantities = {}
        for sku, quantity in items:
            price(sku)
            quantities[sku] = quantities.get(sku, 0) + quantity
        self.lines = [(sku, quantity, price(sku) * self._paid(sku, quantity)) for sku, quantity in quantities.items()]
        self.code = code
        discount(0, code)  # an unknown code fails now, not later

    @staticmethod
    def _paid(sku, quantity):
        """Three teas for the price of two."""
        return quantity - quantity // 3 if sku == "tea" else quantity

    @property
    def subtotal(self):
        return sum(total for _, _, total in self.lines)

    @property
    def discount(self):
        return discount(self.subtotal, self.code)

    @property
    def tax(self):
        return tax(self.subtotal - self.discount)

    @property
    def shipping(self):
        return 0 if self.subtotal - self.discount >= FREE_SHIPPING_FROM else SHIPPING

    @property
    def total(self):
        return self.subtotal - self.discount + self.tax + self.shipping

    def receipt(self):
        out = [f"{sku} x{quantity}  {dollars(total)}" for sku, quantity, total in self.lines]
        out.append(f"Subtotal  {dollars(self.subtotal)}")
        if self.discount:
            out.append(f"Discount {self.code}  {dollars(-self.discount)}")
        out.append(f"Tax  {dollars(self.tax)}")
        if self.shipping:
            out.append(f"Shipping  {dollars(self.shipping)}")
        out.append(f"Total  {dollars(self.total)}")
        return "\n".join(out)
