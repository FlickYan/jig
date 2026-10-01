"""Splitting amounts between people."""

__all__ = ["proportional_shares", "split_evenly"]


def proportional_shares(total_cents: int, weights: list[int]) -> list[int]:
    """Split total_cents in proportion to weights. Leftover cents go to the largest weights first."""
    if not weights or any(w < 0 for w in weights) or sum(weights) == 0:
        raise ValueError("weights must be non-negative and not all zero")
    total_weight = sum(weights)
    shares = [total_cents * w // total_weight for w in weights]
    leftover = total_cents - sum(shares)
    for i in sorted(range(len(weights)), key=lambda i: -weights[i])[:leftover]:
        shares[i] += 1
    return shares


def split_evenly(total_cents: int, people: int) -> list[int]:
    """Split total_cents between people as evenly as possible; the larger shares come first."""
    if people < 1:
        raise ValueError("people must be at least 1")
    base, extra = divmod(total_cents, people)
    return [base + 1] * extra + [base] * (people - extra)
