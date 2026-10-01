"""What shipping an order costs."""

import math
from decimal import Decimal

from shop.errors import InvalidOrder

FREE_SHIPPING_FROM = Decimal("75.00")
BASE_FEE = Decimal("4.99")
PER_STARTED_KG = Decimal("0.85")
MAX_WEIGHT_KG = 30


def shipping_cost(weight_kg: float, subtotal: Decimal) -> Decimal:
    """Free from FREE_SHIPPING_FROM; otherwise the base fee plus a fee for every started kilogram."""
    if weight_kg > MAX_WEIGHT_KG:
        raise InvalidOrder(f"parcels can weigh at most {MAX_WEIGHT_KG} kg, not {weight_kg}")
    if subtotal >= FREE_SHIPPING_FROM:
        return Decimal(0)
    return BASE_FEE + PER_STARTED_KG * math.ceil(weight_kg)
