"""bulk-discount: the behaviour to restore is only in the project's history.

What the agent must find: setup.sh gives the project the history it would have had (1.0, the 1.4 tiers,
the 1.4.1 rounding fix, the 2.0 rewrite). Before 2.0, bulk orders got 5% off from 10 units, 8% from 50 and
12% from 200, at most 150.00 off an order, rounded half up to the cent; 2.0 kept only the 5%. CHANGELOG.md
names the releases but not the numbers, so they have to come from git (git log -p, git show). 2.0's other
rules (the coupon, and the loyalty discount it added) must stay.
"""
from maketask import task

V2 = '''
"""Discounts, as rules: each looks at an order and returns the cents it takes off."""
from decimal import ROUND_HALF_UP, Decimal


def cents(value):
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def coupon(order):
    """SAVE10 takes 10% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.10")) if order.coupon == "SAVE10" else 0


def bulk(order):
    """Bulk orders get 5% off."""
    units = sum(line.quantity for line in order.lines)
    return cents(Decimal(order.subtotal) * Decimal("0.05")) if units >= 10 else 0


def loyalty(order):
    """Customers in the loyalty programme get 2% off."""
    return cents(Decimal(order.subtotal) * Decimal("0.02")) if order.loyal else 0


RULES = [coupon, bulk, loyalty]


def discount(order):
    """What all the rules take off the order, in cents."""
    return sum(rule(order) for rule in RULES)
'''

V1_0 = '''
"""Discounts on orders."""


def discount(order):
    """Bulk orders (10 units or more) get 5% off; SAVE10 takes 10% off."""
    units = sum(line.quantity for line in order.lines)
    off = order.subtotal * 5 // 100 if units >= 10 else 0
    if order.coupon == "SAVE10":
        off += order.subtotal // 10
    return off
'''

V1_4 = '''
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
'''

V1_4_1 = '''
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
'''

CHANGELOG_V2 = """
    # Changelog

    ## 2.0.0 (2026-09-20)
    - Discounts are rules now (pricing/discounts.py), so that new ones are easy to add.
    - New: a 2% loyalty discount for customers in the programme.

    ## 1.4.1 (2025-09-03)
    - Discounts are rounded to the cent instead of cut off (#27).

    ## 1.4.0 (2025-08-12)
    - Bulk orders: tiered discounts for large orders, capped per order.

    ## 1.0.0 (2025-05-01)
    - First release.
    """

FILES = {
    "README.md": """
        # pricing

        Prices and discounts for the shop's orders. Releases are listed in CHANGELOG.md.
        """,
    "CHANGELOG.md": CHANGELOG_V2,
    "pricing/__init__.py": "",
    "pricing/orders.py": """
        from dataclasses import dataclass, field


        @dataclass
        class Line:
            sku: str
            quantity: int
            unit_cents: int


        @dataclass
        class Order:
            lines: list = field(default_factory=list)
            coupon: str = ""
            loyal: bool = False

            @property
            def subtotal(self):
                return sum(line.quantity * line.unit_cents for line in self.lines)
        """,
    "pricing/discounts.py": V2,
    "tests/__init__.py": "",
    "tests/test_discounts.py": """
        import unittest

        from pricing.discounts import discount
        from pricing.orders import Line, Order


        class DiscountTest(unittest.TestCase):
            def test_coupon(self):
                self.assertEqual(discount(Order([Line("M", 2, 1000)], coupon="SAVE10")), 200)

            def test_loyalty(self):
                self.assertEqual(discount(Order([Line("M", 1, 1000)], loyal=True)), 20)
        """,
}


def commit(date, message, files):
    """A commit in setup.sh: the files it changes, then git commit at that date."""
    writes = "".join(f"cat > {path} <<'END_OF_FILE'\n{text.strip()}\nEND_OF_FILE\n" for path, text in files.items())
    return f"{writes}git add -A\nGIT_AUTHOR_DATE='{date}' GIT_COMMITTER_DATE='{date}' git commit -qm '{message}'\n"


def changelog(upto):
    """CHANGELOG.md as it was at a release: the entries from that release down."""
    text = CHANGELOG_V2.replace("\n    ", "\n").strip()
    head, *entries = text.split("\n## ")
    return head.rstrip() + "\n\n## " + "\n\n## ".join(entry.strip() for entry in entries[entries.index(next(e for e in entries if e.startswith(upto))):]) + "\n"


SETUP = f"""
#!/bin/bash
# The project's history up to 2.0, on a branch of its own that then becomes main: 1.0, the 1.4 tiers, the
# 1.4.1 rounding fix and the 2.0 rewrite, whose files are the starting point's.
set -e
git checkout -q --orphan history
git rm -rq --cached . > /dev/null
{commit("2025-05-01T10:00:00", "Pricing: orders and discounts (1.0.0)", {"pricing/discounts.py": V1_0, "CHANGELOG.md": changelog("1.0.0")})}
{commit("2025-08-12T15:30:00", "Tiered bulk discounts, capped per order (1.4.0)", {"pricing/discounts.py": V1_4, "CHANGELOG.md": changelog("1.4.0")})}
{commit("2025-09-03T09:10:00", "Round discounts to the cent instead of cutting them off (1.4.1, #27)", {"pricing/discounts.py": V1_4_1, "CHANGELOG.md": changelog("1.4.1")})}
git checkout -q main -- .
git add -A
GIT_AUTHOR_DATE='2026-09-20T11:00:00' GIT_COMMITTER_DATE='2026-09-20T11:00:00' git commit -qm 'Discounts as rules, and a loyalty discount (2.0.0)'
git tag v2.0.0
git branch -q -D main
git branch -q -m main
"""

SOLUTION = {
    "pricing/discounts.py": V2.replace('''def bulk(order):
    """Bulk orders get 5% off."""
    units = sum(line.quantity for line in order.lines)
    return cents(Decimal(order.subtotal) * Decimal("0.05")) if units >= 10 else 0''', '''# Bulk tiers, as before 2.0: (minimum units in the order, rate). The largest tier that applies wins.
TIERS = [(200, Decimal("0.12")), (50, Decimal("0.08")), (10, Decimal("0.05"))]
BULK_CAP = 15000  # cents: no order gets more than 150.00 off for its size


def bulk(order):
    """Bulk orders get 5%, 8% or 12% off by size, at most 150.00."""
    units = sum(line.quantity for line in order.lines)
    for minimum, rate in TIERS:
        if units >= minimum:
            return min(cents(Decimal(order.subtotal) * rate), BULK_CAP)
    return 0'''),
}

HIDDEN = """
    import unittest

    from pricing.discounts import discount
    from pricing.orders import Line, Order


    def order(units, unit_cents, **kwargs):
        return Order([Line("X", units, unit_cents)], **kwargs)


    class BulkTest(unittest.TestCase):
        def test_tiers(self):
            self.assertEqual(discount(order(9, 1000)), 0)
            self.assertEqual(discount(order(10, 1000)), 500)  # 5%
            self.assertEqual(discount(order(50, 1000)), 4000)  # 8%
            self.assertEqual(discount(order(200, 500)), 12000)  # 12%

        def test_the_cap(self):
            self.assertEqual(discount(order(300, 1000)), 15000)  # 12% would be 360.00

        def test_rounding_half_up(self):
            self.assertEqual(discount(order(51, 1011)), 4125)  # 8% of 515.61 = 41.2488: 41.25, not cut off to 41.24
            self.assertEqual(discount(order(10, 1005)), 503)  # 5% of 100.50 = 5.025 -> 5.03

        def test_the_rest_of_2_0_stays(self):
            self.assertEqual(discount(order(50, 1000, coupon="SAVE10")), 4000 + 5000)
            self.assertEqual(discount(order(50, 1000, loyal=True)), 4000 + 1000)
            self.assertEqual(discount(order(1, 1000, loyal=True)), 20)
"""

task(
    "bulk-discount",
    "Since the 2.0 rewrite, large orders get less off than they used to. Give bulk orders the discount they had before 2.0, and keep everything else 2.0 changed.",
    ["python", "bug", "git history", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
    setup=SETUP,
)
