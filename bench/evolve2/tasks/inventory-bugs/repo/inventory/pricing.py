from functools import lru_cache

from .catalog import CATALOG


@lru_cache(maxsize=None)
def unit_price(sku):
    """A product's price in cents. Looked up for every order line, so it is cached."""
    return CATALOG.get(sku).price_cents
