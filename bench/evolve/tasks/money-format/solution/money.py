DECIMALS = {"USD": 2, "EUR": 2, "GBP": 2, "JPY": 0, "KRW": 0, "BHD": 3, "KWD": 3}
SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥", "KRW": "₩"}
SEPARATORS = {"en": (",", "."), "de": (".", ","), "fr": ("\u202f", ",")}


def format_money(amount, currency, locale="en", accounting=False):
    """An amount in minor units, formatted for a locale. See SPEC.md."""
    if type(amount) is not int:
        raise ValueError(f"amount must be an integer number of minor units, not {amount!r}")
    if currency not in DECIMALS:
        raise ValueError(f"unknown currency {currency!r}")
    if locale not in SEPARATORS:
        raise ValueError(f"unknown locale {locale!r}")
    thousands, point = SEPARATORS[locale]
    places = DECIMALS[currency]
    negative = amount < 0
    whole, part = divmod(abs(amount), 10 ** places)
    digits = f"{whole:,}".replace(",", thousands)
    number = f"{digits}{point}{part:0{places}d}" if places else digits
    symbol = SYMBOLS.get(currency)
    if locale == "en":
        body = f"{symbol}{number}" if symbol else f"{currency} {number}"
        signed = f"-{body}" if negative else body
    else:
        body = f"{number}\u00a0{symbol or currency}"
        signed = f"-{body}" if negative else body
    if accounting and negative:
        return f"({body})"
    return signed
