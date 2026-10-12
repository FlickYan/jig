"""report-reader: the samples show some of the format; the document describes all of it.

What the agent must do beyond its first check: samples/ holds two reports from the old accounting system,
each one page long, and the project's test reads one of them. docs/report-format.md describes what longer
reports have too: page breaks that repeat the header, lines whose account is left blank, descriptions that
go on over a second line, and the older trailing minus for negative amounts, and it asks for an error when
the total doesn't add up. The hidden tests read reports with all of it, made by write_report below.
"""
import random

from maketask import task

FORMAT = """
    # The monthly report

    The old accounting system prints each month's entries as text, in fixed columns:

    | columns | field |
    |---------|-------|
    | 1-8     | account number |
    | 11-20   | date, YYYY-MM-DD |
    | 23-54   | description |
    | 57-68   | amount, right-aligned |

    1. Every page starts with the same four lines: the system's name and the page number, the report's
       title and month, the column headings, and a line of dashes. Pages after the first begin with a form
       feed character (\\f) at the start of the first header line.
    2. Amounts have two decimals and commas between thousands: `1,250.00`. Negative amounts are in
       parentheses, `(120.50)`; reports printed before 2024 write them with a trailing minus, `120.50-`.
    3. A line with a date but no account number belongs to the same account as the entry above it.
    4. A line with a description and nothing else carries on the description of the entry above it, joined
       with a single space.
    5. `SUBTOTAL` lines (one after each account's entries) and the `TOTAL` line at the end aren't entries.
       The total is the sum of all entries; a report whose total doesn't match is damaged.
    6. The last line is `* END OF REPORT *`.
    """


def money(cents, old=False):
    text = f"{abs(cents) // 100:,}.{abs(cents) % 100:02d}"
    if cents < 0:
        return f"{text}-" if old else f"({text})"
    return text


def write_report(month, accounts, lines_per_page=12, old=False, total_shift=0):
    """A report as the old system prints it: accounts is [(account, [(date, description, cents), ...])]."""
    def header(page):
        return [
            f"{'ACME LEDGER SYSTEM':<60}PAGE {page}",
            f"MONTHLY ACCOUNT REPORT  {month}",
            f"{'ACCOUNT':<10}{'DATE':<12}{'DESCRIPTION':<34}{'AMOUNT':>12}",
            f"{'-' * 8}  {'-' * 10}  {'-' * 32}  {'-' * 12}",
        ]
    body = []
    total = 0
    for account, entries in accounts:
        subtotal = 0
        for index, (date, description, cents) in enumerate(entries):
            first, rest = description[:32], description[32:].strip()
            shown_account = account if index == 0 or index % 3 else ""  # some lines leave the account blank
            body.append(f"{shown_account:<10}{date:<12}{first:<34}{money(cents, old):>12}".rstrip())
            while rest:
                body.append(f"{'':<22}{rest[:32]}".rstrip())
                rest = rest[32:].strip()
            subtotal += cents
        body.append(f"{'':<40}{'SUBTOTAL ' + account:<16}{money(subtotal, old):>12}")
        total += subtotal
    body.append(f"{'':<40}{'TOTAL':<16}{money(total + total_shift, old):>12}")
    body.append("* END OF REPORT *")
    lines, page = [], 1
    for start in range(0, len(body), lines_per_page):
        head = header(page)
        if page > 1:
            head[0] = "\f" + head[0]
        lines += head + body[start:start + lines_per_page]
        page += 1
    return "\n".join(lines) + "\n"


def entries_of(accounts):
    return [{"account": a,