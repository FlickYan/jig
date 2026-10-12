"""list what is in stock"""
from stock.money import show


def configure(parser):
    pass


def run(store, args, config):
    return [{"sku": i["sku"], "name": i["name"], "quantity": i["quantity"], "price": show(i["price_cents"])} for i in store.sorted_items()]
