"""add an item, or more of one"""
from stock.errors import BadQuantity
from stock.money import to_cents


def configure(parser):
    parser.add_argument("sku")
    parser.add_argument("name")
    parser.add_argument("quantity", type=int)
    parser.add_argument("price")


def run(store, args, config):
    if args.quantity <= 0:
        raise BadQuantity("quantity must be positive")
    item = store.items.setdefault(args.sku, {"name": args.name, "quantity": 0, "price_cents": to_cents(args.price)})
    item["quantity"] += args.quantity
    store.save()
    return {"sku": args.sku, "quantity": item["quantity"]}
