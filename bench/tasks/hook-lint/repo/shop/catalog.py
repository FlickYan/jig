"""The product catalog: looking products up by SKU and by name."""

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Product:
    sku: str
    name: str
    price: Decimal
    weight_kg: float


def find(products: list[Product], sku: str) -> Product:
    """The product with this SKU. SKUs are case-insensitive."""
    for product in products:
        if product.sku.lower() == sku.lower():
            return product
    raise KeyError(f"no product with SKU {sku}")


def search(products: list[Product], query: str) -> list[Product]:
    """Products whose name contains every word of the query, sorted by name."""
    words = query.lower().split()
    return sorted((p for p in products if all(w in p.name.lower() for w in words)), key=lambda p: p.name)
