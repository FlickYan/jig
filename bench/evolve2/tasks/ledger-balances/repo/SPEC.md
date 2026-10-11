# balances(journal) -> dict

The balance of every account in a double-entry journal, written in a small plain-text format. The
result maps each account to a dict of its balances, `{commodity: Decimal}`.

## The journal

1. Lines end with `\n`. A blank line, or one whose first character other than spaces and tabs is `;`, is
   ignored.
2. A transaction starts with a line, not indented, of a date `YYYY-MM-DD` (a real date), then
   optionally a space and a description, which may be anything.
3. Its postings follow, each on an indented line (starting with spaces or a tab): an account, then at
   least two spaces or a tab, then an amount; or just an account, without an amount. On a posting line,
   everything from a `;` on is a comment.
4. An account name is one or more parts separated by `:` (`assets:bank:checking`). A part is made of
   letters, digits and `-`, `_`, `'`, `&`, `.`, with single spaces between words (`assets:Petty Cash`).
   So a single space before an amount makes it part of the name, which the name's characters then rule
   out.
5. An amount is a quantity and a commodity: dollars, written with `$` before the number (`$45.20`,
   `-$5` or `$-5`), or a code of capital letters after it, after one space (`10 EUR`, `-2.5 AAPL`). The
   quantity is digits, optionally with `.` and more digits after it, and optionally a `-` before it (or
   before the `$`). Quantities are exact decimals. The commodity of dollar amounts is `"$"`.
6. A balance assertion may follow a posting's amount: ` = ` and an amount (`assets:bank  $-20 = $480`).
   After that posting, the account's own balance in the assertion's commodity (its own postings only,
   not its children's) must be exactly that amount.

## Balancing

7. A transaction needs at least two postings that aren't virtual (rule 12), except that a transaction
   whose postings are all virtual needs only one; so a transaction with no postings is invalid. In each,
   the amounts of each commodity, except those of virtual postings, must add up to zero. At most one
   posting may leave out its amount: it takes, for every commodity whose amounts don't add up to zero, the
   amount that balances it (one posting can balance dollars and euros at once).
8. Transactions apply in the order they are written, so an assertion sees every posting written before
   it.
9. Anything wrong raises `ValueError`, with a message that starts with `line N:`, where N is the line's
   number (counting from 1): the date line of a transaction that doesn't balance (rule 7), and otherwise
   the line with the problem (a malformed line, a posting before any transaction, or the posting whose
   assertion fails).

## Balances

10. Every account that has a posting is in the result, and so is every account above it (`assets` and
    `assets:bank` for `assets:bank:checking`). An account's balance is the sum of its own postings and
    of those of all the accounts below it, per commodity. A commodity whose balance is zero is left out
    of an account's dict, which may then be empty.

## More

11. An alias is a line, not indented and outside any transaction, `alias <name> = <account>`, where the
    name is a single part of an account name (rule 4) and the account is an account name. From that line
    on, a posting whose account's first part is the name has it replaced by the account
    (`bank:savings` is `assets:bank:checking:savings` after `alias bank = assets:bank:checking`). An
    alias given again replaces the old one, and the account an alias stands for is taken as written,
    with no alias applied to it. A malformed alias line raises `ValueError` (rule 9).
12. A posting whose account is in parentheses, `(budget:food)  $-45`, is virtual: its amount counts in
    the balances and in assertions like any other's, but not in balancing its transaction (rule 7). A
    virtual posting must have an amount.
13. A total assertion, ` == ` and an amount after a posting's amount, is like a balance assertion (rule
    6), but for the account's balance together with those of all the accounts below it.
