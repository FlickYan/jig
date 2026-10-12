#!/bin/bash
# The project's history up to 2.0, on a branch of its own that then becomes main: 1.0, the 1.4 tiers, the
# 1.4.1 rounding fix and the 2.0 rewrite, whose files are the starting point's.
set -e
git checkout -q --orphan history
git rm -rq --cached . > /dev/null
cat > pricing/discounts.py <<'END_OF_FILE'
"""Discounts on orders."""


def discount(order):
    """Bulk orders (10 units or more) get 5% off; SAVE10 takes 10% off."""
    units = sum(line.quantity for line in order.lines)
    off = order.subtotal * 5 // 100 if units >= 10 else 0
    if order.coupon == "SAVE10":
        off += order.subtotal // 10
    return off
END_OF_FILE
cat > CHANGELOG.md <<'END_OF_FILE'
# Changelog

## 1.0.0 (2025-05-01)
- First release.
END_OF_FILE
git add -A
GIT_AUTHOR_DATE='2025-05-01T10:00:00' GIT_COMMITTER_DATE='2025-05-01T10:00:00' git commit -qm 'Pricing: orders and discounts (1.0.0)'

cat > pricing/discounts.py <<'END_OF_FILE'
"""Discounts on orders."""

# Bulk tiers: (minimum units in the order, percent off). The largest tier that applies wins.
TIERS = [(200, 12), (50, 8), (10, 5)]
BULK_CAP = 15000  # cents: no order gets more than 150.00 off for its size


def bulk_discount(order):
    units = sum(line.quantity for line in order.lines)
    for minimum, percent in TIERS:
        if units >= minimum:
            return min(order.subtotal * percent // 100, BULK_CAP)
    return 0


def discount(order):
    """Bulk tiers, and SAVE10 takes 10% off."""
    off = bulk_discount(order)
    if order.coupon == "SAVE10":
        off += order.subtotal // 10
    return off
END_OF_FILE
cat > CHANGELOG.md <<'END_OF_FILE'
# Changelog

## 1.4.0 (2025-08-12)
- Bulk orders: tiered discounts for large orders, capped per order.

## 1.0.0 (2025-05-01)
- First release.
END_OF_FILE
git add -A
GIT_AUTHOR_DATE='2025-08-12T15:30:00' GIT_COMMITTER_DATE='2025-08-12T15:30:00' git commit -qm 'Tiered bulk discounts, capped per order (1.4.0)'

cat > pricing/discounts.py <<'END_OF_FILE'
"""Discounts on orders."""
from decimal import ROUND_HALF_UP, Decimal

# Bulk tiers: (minimum units in the order, percent off). The largest tier that applies wins.
TIERS = [(200, Decimal("0.12")), (50, Decimal("0.08")), (10, Decimal("0.05"))]
BULK_CAP = 15000  # cents: no order gets more than 150.00 off for its size


def cents(value):
    """Discounts are rounded to the cent, half up (#27: they used to be cut off)."""
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def bulk_discount(order):
    units = sum(line.quantity for line in order.lines)
    for minimum, rate in TIERS:
        if units >= minimum:
            return min(cents(Decimal(order.subtotal) * rate), BULK_CAP)
    return 0


def discount(order):
    """Bulk tiers, and SAVE10 takes 10% off."""
    off = bulk_discount(order)
    if order.coupon == "SAVE10":
        off += cents(Decimal(order.subtotal) * Decimal("0.10"))
    return off
END_OF_FILE
cat > CHANGELOG.md <<'END_OF_FILE'
# Changelog

## 1.4.1 (2025-09-03)
- Discounts are rounded to the cent instead of cut off (#27).

## 1.4.0 (2025-08-12)
- Bulk orders: tiered discounts for large orders, capped per order.

## 1.0.0 (2025-05-01)
- First release.
END_OF_FILE
git add -A
GIT_AUTHOR_DATE='2025-09-03T09:10:00' GIT_COMMITTER_DATE='2025-09-03T09:10:00' git commit -qm 'Round discounts to the cent instead of cutting them off (1.4.1, #27)'

git checkout -q main -- .
git add -A
GIT_AUTHOR_DATE='2026-09-20T11:00:00' GIT_COMMITTER_DATE='2026-09-20T11:00:00' git commit -qm 'Discounts as rules, and a loyalty discount (2.0.0)'
git tag v2.0.0
git branch -q -D main
git branch -q -m main
