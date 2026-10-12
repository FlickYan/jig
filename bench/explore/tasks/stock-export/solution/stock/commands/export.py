"""write the stock, item by item, to a file"""
from stock.files import write_csv


def configure(parser):
    pass


def run(store, args, config):
    rows = [[i["sku"], i["name"], i["quantity"], i["price_cents"]] for i in store.sorted_items()]
    return {"path": write_csv(config, "export", ["sku", "name", "quantity", "unit_price_cents"], rows)}
