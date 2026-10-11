# Prices in cents.
PRICES = {"tea": 1999, "mug": 750, "honey": 425, "spoon": 10, "cups": 200, "kettle": 3995, "jam": 335}


def price(sku):
    if sku not in PRICES:
        raise KeyError(f"no such product: {sku}")
    return PRICES[sku]
