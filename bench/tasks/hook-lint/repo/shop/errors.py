"""Exceptions for orders the shop can't take."""


class InvalidOrder(ValueError):
    """An order the shop can't take, like an unknown product. The API answers these with a 400."""
