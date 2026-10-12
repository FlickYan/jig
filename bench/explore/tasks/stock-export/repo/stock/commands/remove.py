"""take items out of stock"""
from stock.errors import BadQuantity, UnknownItem


def configure(parser):
    parser.add_argument("sku")
    parser.add_argument("quantity", type=int)


def run(store, args, config):
    if args.sku not in store.items:
        raise UnknownItem(f"no item {args.sku}")
    item = store.items[args.sku]
    if not 0 < args.quantity <= item["quantity"]:
        raise BadQuantity(f"can't remove {args.quantity} of {item['quantity']}")
    item["quantity"] -= args.quantity
    store.save()
    return {"sku": args.sku, "quantity": item["quantity"]}
