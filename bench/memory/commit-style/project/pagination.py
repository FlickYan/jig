def page(items, number, size):
    """The items on page `number` (1-based) when `items` is split into pages of `size`."""
    start = number * size
    return items[start:start + size]
