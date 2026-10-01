"""Splitting amounts between people."""

__all__ = ["proportional_shares"]


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
