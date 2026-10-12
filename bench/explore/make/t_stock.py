"""stock-export: a new command must follow conventions that live in the project, not in the instruction.

What the agent must find: commands are modules registered in stock/commands/__init__.py; files are
written through stock/files.write_csv, which puts them in the export directory from stock.ini, names
them <command>-<YYYYMMDD>.csv by stock.clock.today(), and writes money in cents under a currency line;
and results are printed through stock/output.emit, which honours the global --json flag. An agent that
writes its own CSV in the working directory, with prices as floats, fails every hidden test.
"""
from maketask import task

FILES = {
    "README.md": """
        # stock

        A small stock-keeping tool for the shop.

        ```
        python3 -m stock add SKU NAME QUANTITY PRICE
        python3 -m stock remove SKU QUANTITY
        python3 -m stock list
        python3 -m stock report
        ```

        Settings are in `stock.ini`. The conventions every command follows are in docs/commands.md.
        """,
    "docs/commands.md": """
        # How commands work

        - Each command is a module in `stock/commands/` with `configure(parser)` and `run(store, args, config)`,
          listed in `stock/commands/__init__.py`.
        - A command returns what it wants to show, and `stock.output.emit` prints it: a table, or JSON with the
          global `--json` flag. Commands never print themselves.
        - Commands that write files use `stock.files.write_csv`, which decides where files go and how money is
          written in them. Don't open files for writing anywhere else.
        - Errors are `stock.errors.StockError` subclasses; `main` turns them into a message and an exit code.
        """,
    "stock.ini": """
        [export]
        directory = exports

        [money]
        currency = EUR
        """,
    "stock/__init__.py": "",
    "stock/__main__.py": """
        import sys

        from stock.cli import main

        sys.exit(main(sys.argv[1:]))
        """,
    "stock/clock.py": """
        import datetime


        def today():
            \"\"\"The date files are named by. Tests replace it.\"\"\"
            return datetime.date.today()
        """,
    "stock/config.py": """
        import configparser
        import os


        def load(path="stock.ini"):
            parser = configparser.ConfigParser()
            parser.read(path)
            return {
                "export_dir": parser.get("export", "directory", fallback="exports"),
                "currency": parser.get("money", "currency", fallback="EUR"),
            }
        """,
    "stock/errors.py": """
        class StockError(Exception):
            code = 1


        class UnknownItem(StockError):
            code = 3


        class BadQuantity(StockError):
            code = 2
        """,
    "stock/money.py": """
        from decimal import Decimal


        def to_cents(price):
            return int((Decimal(str(price)) * 100).quantize(Decimal("1")))


        def show(cents):
            return f"{cents // 100}.{cents % 100:02d}"
        """,
    "stock/store.py": """
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
        """,
    "stock/files.py": """
        import csv
        import os

        from stock import clock


        def write_csv(config, command, header, rows):
            \"\"\"Writes a command's CSV file and returns its path: <export dir>/<command>-<YYYYMMDD>.csv. Money
            columns hold cents; the first line names the currency they are in.\"\"\"
            os.makedirs(config["export_dir"], exist_ok=True)
            path = os.path.join(config["export_dir"], f"{command}-{clock.today():%Y%m%d}.csv")
            with open(path, "w", newline="") as f:
                f.write(f"# currency: {config['currency']}\\n")
                writer = csv.writer(f)
                writer.writerow(header)
                writer.writerows(rows)
            return path
        """,
    "stock/output.py": """
        import json


        def emit(result, args):
            \"\"\"Prints what a command returned: JSON with --json; otherwise a list of rows as a table, and
            anything else as `key: value` lines.\"\"\"
            if args.json:
                print(json.dumps(result, sort_keys=True))
            elif isinstance(result, list):
                if result:
                    keys = list(result[0])
                    widths = [max(len(str(k)), *(len(str(row[k])) for row in result)) for k in keys]
                    print("  ".join(str(k).ljust(w) for k, w in zip(keys, widths)).rstrip())
                    for row in result:
                        print("  ".join(str(row[k]).ljust(w) for k, w in zip(keys, widths)).rstrip())
            else:
                for key, value in result.items():
                    print(f"{key}: {value}")
        """,
    "stock/cli.py": """
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
        """,
    "stock/commands/__init__.py": """
        from stock.commands import add, list_items, remove, report

        COMMANDS = {
            "add": add,
            "remove": remove,
            "list": list_items,
            "report": report,
        }
        """,
    "stock/commands/add.py": """
        \"\"\"add an item, or more of one\"\"\"
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
        """,
    "stock/commands/remove.py": """
        \"\"\"take items out of stock\"\"\"
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
        """,
    "stock/commands/list_items.py": """
        \"\"\"list what is in stock\"\"\"
        from stock.money import show


        def configure(parser):
            pass


        def run(store, args, config):
            return [{"sku": i["sku"], "name": i["name"], "quantity": i["quantity"], "price": show(i["price_cents"])} for i in store.sorted_items()]
        """,
    "stock/commands/report.py": """
        \"\"\"write the value of the stock, item by item, to a file\"\"\"
        from stock.files import write_csv


        def configure(parser):
            pass


        def run(store, args, config):
            rows = [[i["sku"], i["quantity"] * i["price_cents"]] for i in store.sorted_items()]
            return {"path": write_csv(config, "report", ["sku", "value"], rows)}
        """,
    "tests/__init__.py": "",
    "tests/test_stock.py": """
        import contextlib
        import io
        import os
        import tempfile
        import unittest

        from stock.cli import main


        class StockTest(unittest.TestCase):
            def setUp(self):
                self.dir = tempfile.TemporaryDirectory()
                self.old = os.getcwd()
                os.chdir(self.dir.name)

            def tearDown(self):
                os.chdir(self.old)
                self.dir.cleanup()

            def run_cli(self, *argv):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    code = main(list(argv))
                return code, out.getvalue()

            def test_add_and_list(self):
                self.run_cli("add", "M1", "Mug", "3", "7.50")
                code, out = self.run_cli("list")
                self.assertEqual(code, 0)
                self.assertIn("Mug", out)
                self.assertIn("7.50", out)
        """,
}

EXPORT = '''
"""write the stock, item by item, to a file"""
from stock.files import write_csv


def configure(parser):
    pass


def run(store, args, config):
    rows = [[i["sku"], i["name"], i["quantity"], i["price_cents"]] for i in store.sorted_items()]
    return {"path": write_csv(config, "export", ["sku", "name", "quantity", "unit_price_cents"], rows)}
'''

SOLUTION = {
    "stock/commands/export.py": EXPORT,
    "stock/commands/__init__.py": """
        from stock.commands import add, export, list_items, remove, report

        COMMANDS = {
            "add": add,
            "remove": remove,
            "list": list_items,
            "report": report,
            "export": export,
        }
        """,
}

HIDDEN = """
    import contextlib
    import datetime
    import io
    import json
    import os
    import tempfile
    import unittest
    from unittest import mock

    from stock.cli import main


    class ExportTest(unittest.TestCase):
        def setUp(self):
            self.dir = tempfile.TemporaryDirectory()
            self.old = os.getcwd()
            os.chdir(self.dir.name)
            with open("stock.ini", "w") as f:
                f.write("[export]\\ndirectory = out/files\\n\\n[money]\\ncurrency = GBP\\n")
            self.today = mock.patch("stock.clock.today", return_value=datetime.date(2026, 3, 9))
            self.today.start()
            for argv in (["add", "T9", "Tea, green", "4", "3.20"], ["add", "A1", "Apron", "2", "12"]):
                self.run_cli(*argv)

        def tearDown(self):
            self.today.stop()
            os.chdir(self.old)
            self.dir.cleanup()

        def run_cli(self, *argv):
            out, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(list(argv))
            return code, out.getvalue()

        def test_writes_the_file_where_and_as_the_project_writes_files(self):
            code, out = self.run_cli("export")
            self.assertEqual(code, 0)
            path = os.path.join("out/files", "export-20260309.csv")
            self.assertTrue(os.path.exists(path), os.listdir("."))
            with open(path) as f:
                lines = f.read().splitlines()
            self.assertEqual(lines[0], "# currency: GBP")
            self.assertEqual(lines[2:], ["A1,Apron,2,1200", 'T9,"Tea, green",4,320'])

        def test_prints_the_path_the_way_commands_print(self):
            path = os.path.join("out/files", "export-20260309.csv")
            self.assertEqual(self.run_cli("export"), (0, f"path: {path}\\n"))
            code, out = self.run_cli("--json", "export")
            self.assertEqual((code, json.loads(out)), (0, {"path": path}))

        def test_is_a_command_like_the_others(self):
            from stock.commands import COMMANDS
            self.assertIn("export", COMMANDS)
            self.assertTrue(COMMANDS["export"].__doc__)
"""

task(
    "stock-export",
    "Add an `export` command to the stock tool that writes every item in stock to a CSV file (SKU, name, quantity and unit price) and shows where it wrote it.",
    ["python", "feature", "conventions", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
