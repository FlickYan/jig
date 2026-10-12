import logging
import sys

from catalog.importer import import_prices

log = logging.getLogger("nightly")


def run(path):
    log.info("nightly import started: %s", path)
    rows = import_prices(path)
    log.info("imported %d rows", len(rows))
    return rows


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run(sys.argv[1])
