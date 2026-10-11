"""bank: a small bank's accounts, from the command line."""
import argparse

from . import audit
from .dates import parse_date, today
from .money import format_amount, parse_amount
from .output import BAD_INPUT, CANT, emit, fail
from .store import Store, Unknown, check_id

KINDS = ["deposit", "withdraw", "transfer"]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="bank")
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("open", help="open an account")
    command.add_argument("account")
    command.add_argument("owner")
    for name in ("deposit", "withdraw"):
        command = commands.add_parser(name, help=f"{name} money")
        command.add_argument("account")
        command.add_argument("amount")
    command = commands.add_parser("transfer", help="move money between accounts")
    command.add_argument("source")
    command.add_argument("target")
    command.add_argument("amount")
    command = commands.add_parser("balance", help="an account's balance")
    command.add_argument("account")
    command = commands.add_parser("history", help="an account's transactions")
    command.add_argument("account")
    command.add_argument("--from", dest="start", help="YYYY-MM-DD, included")
    command.add_argument("--to", dest="end", help="YYYY-MM-DD, included")
    command.add_argument("--kind", choices=KINDS)
    STATEMENT_PARSER
    args = parser.parse_args(argv)
    store = Store()
    try:
        return COMMANDS[args.command](store, args)
    except ValueError as error:
        return fail(str(error), BAD_INPUT)
    except Unknown as error:
        return fail(str(error), CANT)


def open_account(store, args):
    check_id(args.account)
    if not args.owner.strip():
        raise ValueError("the owner's name can't be empty")
    if args.account in store.data["accounts"]:
        return fail(f"account exists: {args.account}", CANT)
    store.data["accounts"][args.account] = {"owner": args.owner, "transactions": []}
    store.save()
    audit.record("open", account=args.account, owner=args.owner)
    return emit({"account": args.account, "owner": args.owner, "balance": format_amount(0)})


def deposit(store, args):
    check_id(args.account)
    amount = parse_amount(args.amount)
    record = store.account(args.account)
    record["transactions"].append({"date": today().isoformat(), "kind": "deposit", "amount": amount})
    store.save()
    audit.record("deposit", account=args.account, amount=format_amount(amount))
    return emit({"account": args.account, "balance": format_amount(store.balance(record))})


def withdraw(store, args):
    check_id(args.account)
    amount = parse_amount(args.amount)
    record = store.account(args.account)
    if store.balance(record) < amount:
        return fail(f"not enough money in {args.account}: {format_amount(store.balance(record))}", CANT)
    record["transactions"].append({"date": today().isoformat(), "kind": "withdraw", "amount": -amount})
    store.save()
    audit.record("withdraw", account=args.account, amount=format_amount(amount))
    return emit({"account": args.account, "balance": format_amount(store.balance(record))})


def transfer(store, args):
    check_id(args.source)
    check_id(args.target)
    if args.source == args.target:
        raise ValueError("can't transfer to the same account")
    amount = parse_amount(args.amount)
    source, target = store.account(args.source), store.account(args.target)
    if store.balance(source) < amount:
        return fail(f"not enough money in {args.source}: {format_amount(store.balance(source))}", CANT)
    day = today().isoformat()
    source["transactions"].append({"date": day, "kind": "transfer", "amount": -amount, "to": args.target})
    target["transactions"].append({"date": day, "kind": "transfer", "amount": amount, "from": args.source})
    store.save()
    audit.record("transfer", source=args.source, target=args.target, amount=format_amount(amount))
    return emit({
        "source": {"account": args.source, "balance": format_amount(store.balance(source))},
        "target": {"account": args.target, "balance": format_amount(store.balance(target))},
    })


def balance(store, args):
    check_id(args.account)
    record = store.account(args.account)
    return emit({"account": args.account, "owner": record["owner"], "balance": format_amount(store.balance(record))})


def shown(transaction):
    """A transaction as the commands show it: its amount formatted, everything else as recorded."""
    return {**transaction, "amount": format_amount(transaction["amount"])}


def history(store, args):
    check_id(args.account)
    start = parse_date(args.start) if args.start else None
    end = parse_date(args.end) if args.end else None
    if start and end and start > end:
        raise ValueError("--from is after --to")
    record = store.account(args.account)
    transactions = [
        shown(t) for t in record["transactions"]
        if (not start or t["date"] >= start.isoformat()) and (not end or t["date"] <= end.isoformat()) and (not args.kind or t["kind"] == args.kind)
    ]
    return emit({"account": args.account, "transactions": transactions})

STATEMENT_FUNCTION
COMMANDS = {"open": open_account, "deposit": deposit, "withdraw": withdraw, "transfer": transfer, "balance": balance, "history": history STATEMENT_COMMAND}
