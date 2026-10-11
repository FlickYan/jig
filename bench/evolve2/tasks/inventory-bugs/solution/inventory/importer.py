import csv

from .catalog import CATALOG, Product


def import_csv(path):
    """Adds the products in a supplier's CSV (columns sku, name, price) to the catalog; returns how many."""
    count = 0
    # utf-8-sig: Excel starts the CSVs it writes with a byte-order mark.
    with open(path, newline="", encoding="utf-8-sig") as file:
        for row in csv.DictReader(file):
            row = {key.strip(): value.strip() for key, value in row.items()}
            CATALOG.add(Product(row["sku"], row["name"], _cents(row["price"])))
            count += 1
    return count


def _cents(text):
    dollars, _, cents = text.partition(".")
    return int(dollars) * 100 + int((cents + "00")[:2])
