#!/usr/bin/env python3
"""The shop team's linter: rules reviewers kept repeating, checked by a machine instead.

Usage: shoplint [file ...]    (run in the project; default: every module in shop/)

Rules:
  no-magic-numbers  Numbers inside functions, other than 0 and 1, must be module-level constants
                    with a name (numbers in Decimal("...") strings too). A price change is then a
                    one-line diff, and a reviewer can see what each number means.
  domain-errors     Don't raise ValueError: raise shop.errors.InvalidOrder, which the API answers
                    with a 400 (any other exception becomes a 500). InvalidOrder is a ValueError,
                    so code that catches ValueError still works.

Prints one line per problem and exits with 1 if there are any. Files outside shop/ are skipped.
"""

import ast
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path.cwd()
PACKAGE = ROOT / "shop"
ALLOWED = {0, 1}


def magic_number(node):
    """The magic number a node writes out, or None."""
    if isinstance(node, ast.Constant) and type(node.value) in (int, float) and node.value not in ALLOWED:
        return repr(node.value)
    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Decimal" and node.args:
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            try:
                if Decimal(arg.value) not in ALLOWED:
                    return f'Decimal("{arg.value}")'
            except InvalidOperation:
                pass
    return None


def raises_value_error(node):
    if not isinstance(node, ast.Raise) or node.exc is None:
        return False
    exc = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
    return isinstance(exc, ast.Name) and exc.id == "ValueError"


def problems(path):
    tree = ast.parse(path.read_text(), filename=str(path))
    for node in ast.walk(tree):
        if raises_value_error(node):
            yield node.lineno, (
                "raise InvalidOrder (from shop.errors) instead of ValueError: the API answers InvalidOrder with a 400, "
                "and any other exception with a 500. InvalidOrder is a ValueError, so callers catching ValueError "
                "still work. [domain-errors]"
            )
    seen = set()
    for function in ast.walk(tree):
        if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for node in ast.walk(function):
            number = magic_number(node)
            if number and (node.lineno, node.col_offset) not in seen:
                seen.add((node.lineno, node.col_offset))
                yield node.lineno, (
                    f"{number} in {function.name}() is a magic number. Make it a module-level constant "
                    f"with a name that says what it is, and use the name. [no-magic-numbers]"
                )


def main(args):
    paths = [Path(arg).resolve() for arg in args] or sorted(PACKAGE.glob("*.py"))
    count = 0
    for path in paths:
        if path.suffix != ".py" or not path.is_relative_to(PACKAGE) or not path.exists():
            continue
        for line, message in sorted(problems(path)):
            print(f"{path.relative_to(ROOT)}:{line}: {message}")
            count += 1
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
