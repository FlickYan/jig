from shop.catalog.products import CATALOG


def search(query):
    """Products whose name contains every word of the query, cheapest first."""
    words = query.lower().split()
    found = [p for p in CATALOG.values() if all(w in p.name.lower() for w in words)]
    return sorted(found, key=lambda p: p.price_cents)
