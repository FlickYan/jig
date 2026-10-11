from .catalog import price
from .discounts import discount
from .money import dollars
from .tax import tax


class Order:
    def __init__(self, items, code=None):
        """items: (sku, quantity) pairs."""
        self.lines = [(sku, quantity, price(sku) * quantity) for sku, quantity in items]
        self.code = code
        discount(0, code)  # an unknown code fails now, not later

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
    def total(self):
        return self.subtotal - self.discount + self.tax

    def receipt(self):
        out = [f"{sku} x{quantity}  {dollars(total)}" for sku, quantity, total in self.lines]
        out.append(f"Subtotal  {dollars(self.subtotal)}")
        if self.code:
            out.append(f"Discount {self.code}  {dollars(-self.discount)}")
        out.append(f"Tax  {dollars(self.tax)}")
        out.append(f"Total  {dollars(self.total)}")
        return "\n".join(out)
