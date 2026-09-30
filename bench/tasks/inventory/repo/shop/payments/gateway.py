from shop.errors import PaymentDeclined


class FakeGateway:
    """Stands in for the payment provider in development and tests."""

    def __init__(self, decline=False):
        self.decline = decline
        self.charges = []

    def charge(self, customer_id, amount_cents):
        if self.decline:
            raise PaymentDeclined("Your card was declined")
        self.charges.append((customer_id, amount_cents))
