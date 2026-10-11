import re


def parse_amount(text):
    """An amount typed by the user, like 12.34, in cents. It must be positive, with at most two decimals."""
    if not re.fullmatch(r"\d+(\.\d{1,2})?", text):
        raise ValueError(f"invalid amount: {text} (use a positive number with at most two decimals)")
    dollars, _, cents = text.partition(".")
    amount = int(dollars) * 100 + int(cents.ljust(2, "0"))
    if amount == 0:
        raise ValueError(f"invalid amount: {text} (use a positive number with at most two decimals)")
    return amount


def format_amount(cents):
    """Cents as the bank shows them: 12.34, -5.00."""
    sign = "-" if cents < 0 else ""
    return f"{sign}{abs(cents) // 100}.{abs(cents) % 100:02d}"
