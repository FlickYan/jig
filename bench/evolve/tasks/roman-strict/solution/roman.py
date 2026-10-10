PAIRS = [(1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"), (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")]


def to_roman(n):
    """The Roman numeral for n. See SPEC.md."""
    if type(n) is not int or not 1 <= n <= 3999:
        raise ValueError(f"no Roman numeral for {n!r}")
    out = []
    for value, letters in PAIRS:
        while n >= value:
            out.append(letters)
            n -= value
    return "".join(out)


STANDARD = {to_roman(n): n for n in range(1, 4000)}


def from_roman(text):
    """The number a Roman numeral stands for. See SPEC.md."""
    key = text.strip().upper() if isinstance(text, str) else None
    if key not in STANDARD:
        raise ValueError(f"not a Roman numeral in standard form: {text!r}")
    return STANDARD[key]
