import json
import os

DATA = os.environ.get("SHOP_DATA", os.path.join(os.path.dirname(__file__), "..", "data"))


def load(name):
    with open(os.path.join(DATA, f"{name}.json")) as f:
        return json.load(f)
