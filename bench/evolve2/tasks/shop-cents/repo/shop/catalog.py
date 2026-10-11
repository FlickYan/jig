# Prices in dollars.
PRICES = {"tea": 19.99, "mug": 7.50, "honey": 4.25, "spoon": 0.10, "cups": 2.00, "kettle": 39.95, "jam": 3.35}


def price(sku):
    if sku not in PRICES:
        raise KeyError(f"no such product: {sku}")
    return PRICES[sku]
