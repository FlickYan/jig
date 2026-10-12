import sys

from shop.errors import NotFound, Refused
from shop.orders import place_order


def main(argv):
    """shop order CUSTOMER ITEM=QUANTITY..."""
    if len(argv) < 3 or argv[0] != "order":
        print("usage: shop order CUSTOMER ITEM=QUANTITY...", file=sys.stderr)
        return 2
    items = {name: int(quantity) for name, quantity in (arg.split("=") for arg in argv[2:])}
    try:
        order = place_order(argv[1], items)
    except NotFound as err:
        print(f"error: {err}", file=sys.stderr)
        return 3
    except Refused as err:
        print(f"refused: {err}", file=sys.stderr)
        return 4
    print(f"placed order for {order['cents'] / 100:.2f}")
    return 0
