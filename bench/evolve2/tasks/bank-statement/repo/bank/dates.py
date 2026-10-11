import os
import re
from datetime import date


def today():
    """Today's date, or BANK_TODAY's (YYYY-MM-DD) if it is set."""
    return parse_date(os.environ["BANK_TODAY"]) if os.environ.get("BANK_TODAY") else date.today()


def parse_date(text):
    """A date written YYYY-MM-DD."""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            return date.fromisoformat(text)
    except ValueError:
        pass
    raise ValueError(f"invalid date: {text} (use YYYY-MM-DD)")
