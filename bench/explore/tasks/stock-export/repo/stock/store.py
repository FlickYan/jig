import json
import os


class Store:
    def __init__(self, path=None):
        self.path = path or os.environ.get("STOCK_DB", "stock.json")
        self.items = {}
        if os.path.exists(self.path):
            with open(self.path) as f:
                self.items = json.load(f)

    def save(self):
        with open(self.path, "w") as f:
            json.dump(self.items, f, indent=2, sort_keys=True)

    def sorted_items(self):
        return [dict(sku=sku, **item) for sku, item in sorted(self.items.items())]
