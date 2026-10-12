from datetime import date


def entry(account, cents, day, memo=""):
    """A ledger entry: an amount in cents on an account, on a day."""
    return {"account": account, "cents": cents, "day": day, "memo": memo}


def parse_day(text):
    """A day written YYYY-MM-DD."""
    return date.fromisoformat(text)
