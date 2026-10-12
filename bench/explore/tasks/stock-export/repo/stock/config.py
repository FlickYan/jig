import configparser
import os


def load(path="stock.ini"):
    parser = configparser.ConfigParser()
    parser.read(path)
    return {
        "export_dir": parser.get("export", "directory", fallback="exports"),
        "currency": parser.get("money", "currency", fallback="EUR"),
    }
