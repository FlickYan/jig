from shop.errors import NotFound, Refused
from shop.orders import place_order


def post_order(body):
    """POST /orders: returns (status, body)."""
    try:
        order = place_order(body["customer"], body["items"])
    except NotFound as err:
        return 404, {"error": str(err)}
    except Refused as err:
        return 409, {"error": str(err)}
    return 201, order
