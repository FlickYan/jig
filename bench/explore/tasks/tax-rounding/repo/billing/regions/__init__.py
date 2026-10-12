import importlib
import os

HERE = os.path.dirname(__file__)


def plugin(region):
    """The tax rules of a region, as listed in config/regions.txt."""
    path = os.path.join(HERE, "..", "..", "config", "regions.txt")
    with open(path) as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                code, module = line.split()
                if code == region:
                    return importlib.import_module(f"billing.regions.{module}")
    raise KeyError(f"no tax rules for region {region}")
