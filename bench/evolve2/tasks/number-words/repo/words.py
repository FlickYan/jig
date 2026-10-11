def to_words(n, style="us"):
    """n in US English words. See SPEC.md."""
    raise NotImplementedError


def to_ordinal(n, style="us"):
    """n as an ordinal in words: first, forty-second. See SPEC.md."""
    raise NotImplementedError


def from_words(text, style="us"):
    """The number to_words writes as text. See SPEC.md."""
    raise NotImplementedError


def to_cheque(amount):
    """An amount of money in words, as on a cheque. See SPEC.md."""
    raise NotImplementedError
