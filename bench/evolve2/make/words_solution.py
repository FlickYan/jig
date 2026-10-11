"""Numbers in English words. See SPEC.md."""
import re
from decimal import Decimal, InvalidOperation

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
SCALES = [(10**12, "trillion"), (10**9, "billion"), (10**6, "million"), (10**3, "thousand")]
IRREGULAR = {"one": "first", "two": "second", "three": "third", "five": "fifth", "eight": "eighth", "nine": "ninth", "twelve": "twelfth"}
LIMIT = 10**15


def _check(n):
    if isinstance(n, bool) or not isinstance(n, int):
        raise TypeError(f"not an int: {n!r}")
    if abs(n) >= LIMIT:
        raise ValueError(f"out of range: {n}")


def _british(style):
    if style not in ("us", "uk"):
        raise ValueError(f"style must be 'us' or 'uk', not {style!r}")
    return style == "uk"


def to_words(n, style="us"):
    _check(n)
    british = _british(style)
    if n == 0:
        return "zero"
    if n < 0:
        return "minus " + to_words(-n, style)
    words = []
    for scale, name in SCALES:
        if n >= scale:
            words += [_below_thousand(n // scale, british), name]
            n %= scale
    if n:
        if british and words and n < 100:
            words.append("and")
        words.append(_below_thousand(n, british))
    return " ".join(words)


def _below_thousand(n, british):
    words = []
    if n >= 100:
        words += [ONES[n // 100], "hundred"]
        n %= 100
        if n and british:
            words.append("and")
    if n >= 20:
        words.append(TENS[n // 10] + (f"-{ONES[n % 10]}" if n % 10 else ""))
    elif n:
        words.append(ONES[n])
    return " ".join(words)


def to_ordinal(n, style="us"):
    _check(n)
    if n < 0:
        raise ValueError("no ordinal for a negative number")
    words = to_words(n, style).split(" ")
    head, dash, last = words[-1].rpartition("-")
    if last in IRREGULAR:
        last = IRREGULAR[last]
    elif last.endswith("y"):
        last = last[:-1] + "ieth"
    else:
        last += "th"
    words[-1] = head + dash + last
    return " ".join(words)


def from_words(text, style="us"):
    if not isinstance(text, str):
        raise TypeError(f"not a string: {text!r}")
    british = _british(style)
    values = {word: value for value, word in enumerate(ONES)}
    values.update({word: 10 * value for value, word in enumerate(TENS) if word})
    scales = {name: scale for scale, name in SCALES}
    words = text.split(" ")
    negative = words[0] == "minus"
    total = group = 0
    for word in words[1:] if negative else words:
        tens, dash, unit = word.partition("-")
        if dash and tens in TENS[2:] and unit in ONES[1:10]:
            group += values[tens] + values[unit]
        elif word in values:
            group += values[word]
        elif word == "hundred":
            group *= 100
        elif word in scales:
            total, group = total + group * scales[word], 0
        elif not (british and word == "and"):
            raise ValueError(f"not a number in words: {text!r}")
    n = -(total + group) if negative else total + group
    if abs(n) >= LIMIT or to_words(n, style) != text:
        raise ValueError(f"not a number in words: {text!r}")
    return n


def to_cheque(amount):
    if isinstance(amount, bool) or isinstance(amount, float):
        raise TypeError(f"not an exact amount: {amount!r}")
    if isinstance(amount, int):
        amount = Decimal(amount)
    elif isinstance(amount, str):
        if not re.fullmatch(r"\d+(\.\d{1,2})?", amount):
            raise ValueError(f"not an amount: {amount!r}")
        amount = Decimal(amount)
    elif not isinstance(amount, Decimal):
        raise TypeError(f"not an amount: {amount!r}")
    try:
        cents = amount * 100
        if not amount.is_finite() or cents != cents.to_integral_value() or amount < 0 or amount >= LIMIT:
            raise ValueError(f"not an amount for a cheque: {amount}")
    except InvalidOperation:
        raise ValueError(f"not an amount for a cheque: {amount}") from None
    dollars, cents = divmod(int(cents), 100)
    cents_words = "no cents" if cents == 0 else f"{to_words(cents)} cent{'s' if cents != 1 else ''}"
    return f"{to_words(dollars)} dollar{'s' if dollars != 1 else ''} and {cents_words}"
