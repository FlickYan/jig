import argparse
import sys

from stock import config as settings
from stock.commands import COMMANDS
from stock.errors import StockError
from stock.output import emit
from stock.store import Store


def main(argv):
    parser = argparse.ArgumentParser(prog="stock")
    parser.add_argument("--json", action="store_true", help="print JSON")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, module in COMMANDS.items():
        module.configure(commands.add_parser(name, help=module.__doc__))
    args = parser.parse_args(argv)
    store = Store()
    try:
        result = COMMANDS[args.command].run(store, args, settings.load())
    except StockError as err:
        print(f"error: {err}", file=sys.stderr)
        return err.code
    emit(result, args)
    return 0
