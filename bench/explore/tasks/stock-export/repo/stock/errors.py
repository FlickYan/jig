class StockError(Exception):
    code = 1


class UnknownItem(StockError):
    code = 3


class BadQuantity(StockError):
    code = 2
