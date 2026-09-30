from dataclasses import dataclass

from shop.errors import UnknownProduct


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price_cents: int


CATALOG = {
    "SKU-100": Product("SKU-100", "Espresso beans 1kg", 2400),
    "SKU-123": Product("SKU-123", "Pour-over kettle", 5900),
    "SKU-200": Product("SKU-200", "Paper filters (100)", 700),
    "SKU-310": Product("SKU-310", "Hand grinder", 8900),
}


def get_product(sku):
    try:
        return CATALOG[sku]
    except KeyError:
        raise UnknownProduct(f"Unknown product {sku}") from None
