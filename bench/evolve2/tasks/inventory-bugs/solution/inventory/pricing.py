from .catalog import CATALOG


def unit_price(sku):
    """A product's price in cents: the catalog's, as it is now."""
    return CATALOG.get(sku).price_cents
