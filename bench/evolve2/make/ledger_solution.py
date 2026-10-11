"""Account balances from a plain-text double-entry journal. See SPEC.md."""
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal

PART = r"[A-Za-z0-9\-_'&.]+(?: [A-Za-z0-9\-_'&.]+)*"
ACCOUNT = re.compile(rf"{PART}(?::{PART})*")
QUANTITY = r"\d+(?:\.\d+)?"
AMOUNT = re.compile(rf"(-)?\$(-)?({QUANTITY})|(-)?({QUANTITY}) ([A-Z]+)")
HEADER = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?: .*)?")
ALIAS = re.compile(rf"alias ({PART}) = ({PART}(?::{PART})*)")


def _amount(text, number):
    match = AMOUNT.fullmatch(text)
    if not match:
        raise ValueError(f"line {number}: not an amount: {text!r}")
    if match.group(3) is not None:
        if match.group(1) and match.group(2):
            raise ValueError(f"line {number}: not an amount: {text!r}")
        sign = -1 if (match.group(1) or match.group(2)) else 1
        return "$", sign * Decimal(match.group(3))
    return match.group(6), (-1 if match.group(4) else 1) * Decimal(match.group(5))


def balances(journal):
    own = defaultdict(lambda: defaultdict(Decimal))
    transactions = []
    current = None
    aliases = {}
    for number, line in enumerate(journal.split("\n"), 1):
        if not line.strip() or line.lstrip().startswith(";"):
            continue
        if line[0] in " \t":
            if current is None:
                raise ValueError(f"line {number}: a posting outside a transaction")
            body = line.split(";", 1)[0].strip()
            parts = re.split(r"  +|\t", body, maxsplit=1)
            account = parts[0].strip()
            virtual = account.startswith("(") and account.endswith(")")
            if virtual:
                account = account[1:-1]
            if not ACCOUNT.fullmatch(account):
                raise ValueError(f"line {number}: not an account: {account!r}")
            first, colon, rest_of_name = account.partition(":")
            if first in aliases:
                account = aliases[first] + colon + rest_of_name
            amount = assertion = None
            if len(parts) == 2:
                rest = parts[1].strip()
                for sign, total in ((" == ", True), (" = ", False)):
                    if sign in rest:
                        rest, asserted = rest.split(sign, 1)
                        assertion = (*_amount(asserted.strip(), number), total)
                        break
                amount = _amount(rest.strip(), number)
            if virtual and amount is None:
                raise ValueError(f"line {number}: a virtual posting needs an amount")
            current["postings"].append((number, account, amount, assertion, virtual))
            continue
        if line.startswith("alias"):
            match = ALIAS.fullmatch(line.rstrip())
            if not match:
                raise ValueError(f"line {number}: not an alias")
            aliases[match.group(1)] = match.group(2)
            current = None
            continue
        match = HEADER.fullmatch(line.rstrip())
        if not match:
            raise ValueError(f"line {number}: not a transaction")
        try:
            date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        except ValueError:
            raise ValueError(f"line {number}: not a date") from None
        current = {"line": number, "postings": []}
        transactions.append(current)
    for transaction in transactions:
        postings = transaction["postings"]
        number = transaction["line"]
        real = [p for p in postings if not p[4]]
        if not postings or len(real) == 1:
            raise ValueError(f"line {number}: a transaction needs two postings")
        totals = defaultdict(Decimal)
        for _, _, amount, _, virtual in postings:
            if amount and not virtual:
                totals[amount[0]] += amount[1]
        elided = [p for p in postings if p[2] is None]
        if len(elided) > 1:
            raise ValueError(f"line {number}: more than one posting without an amount")
        unbalanced = {commodity: total for commodity, total in totals.items() if total != 0}
        if unbalanced and not elided:
            raise ValueError(f"line {number}: the transaction doesn't balance")
        for posting_line, account, amount, assertion, _ in postings:
            if amount is None:
                for commodity, total in unbalanced.items():
                    own[account][commodity] -= total
                own[account]  # an account with a posting is listed even if nothing is left
            else:
                own[account][amount[0]] += amount[1]
            if assertion:
                commodity, quantity, total = assertion
                balance = sum((amounts[commodity] for name, amounts in own.items() if name == account or name.startswith(account + ":")), Decimal(0)) if total else own[account][commodity]
                if balance != quantity:
                    raise ValueError(f"line {posting_line}: the balance of {account} isn't {quantity} {commodity}")
    result = {}
    for account, amounts in own.items():
        parts = account.split(":")
        for depth in range(1, len(parts) + 1):
            name = ":".join(parts[:depth])
            totals = result.setdefault(name, {})
            for commodity, quantity in amounts.items():
                totals[commodity] = totals.get(commodity, Decimal(0)) + quantity
    return {account: {c: q for c, q in totals.items() if q != 0} for account, totals in result.items()}
