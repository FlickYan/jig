"""Errors whose messages are shown to customers."""


class ShopError(Exception):
    pass


class UnknownProduct(ShopError):
    pass


class OutOfStock(ShopError):
    pass


class PaymentDeclined(ShopError):
    pass


class InvalidDiscount(ShopError):
    pass
