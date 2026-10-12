from dataclasses import dataclass, field


@dataclass
class Line:
    sku: str
    quantity: int
    unit_cents: int


@dataclass
class Order:
    lines: list = field(default_factory=list)
    coupon: str = ""
    loyal: bool = False

    @property
    def subtotal(self):
        return sum(line.quantity * line.unit_cents for line in self.lines)
