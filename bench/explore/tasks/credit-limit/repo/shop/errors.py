class ShopError(Exception):
    """Base of the errors the front ends report to the user."""


class NotFound(ShopError):
    pass


class Refused(ShopError):
    """The shop won't do what was asked, for a reason the user should be told."""
