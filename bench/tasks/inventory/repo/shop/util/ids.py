import itertools

_counter = itertools.count(1)


def next_order_id():
    return f"ORD-{next(_counter):06d}"
