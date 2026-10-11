from dataclasses import dataclass


@dataclass
class Movement:
    date: str  # D/M/YYYY, as the warehouse writes it
    sku: str
    quantity: int  # positive in, negative out


class Stock:
    def __init__(self):
        self.movements = []

    def record(self, date, sku, quantity):
        self.movements.append(Movement(date, sku, quantity))

    def level(self, sku):
        return sum(m.quantity for m in self.movements if m.sku == sku)
