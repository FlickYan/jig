from dataclasses import dataclass


@dataclass
class Product:
    sku: str
    name: str
    price_cents: int


class Catalog:
    def __init__(self):
        self.products = {}

    def add(self, product):
        self.products[product.sku] = product

    def get(self, sku):
        if sku not in self.products:
            raise KeyError(f"no product {sku}")
        return self.products[sku]

    def set_price(self, sku, cents):
        self.get(sku).price_cents = cents


CATALOG = Catalog()  # the shop's catalog
