# bank statement

Add a command, `bank statement ACCOUNT --month YYYY-MM`, that shows an account's statement for a
month, with these fields:

- `account` and `month`, as given;
- `opening_balance`: the account's balance at the start of the month;
- `transactions`: the account's transactions in that month, in the order they were made, each as
  `bank history` shows it, with one more field, `balance`: the account's balance after it;
- `closing_balance`: the balance at the end of the month.

A month that isn't written `YYYY-MM`, or isn't a real month, is an error: `invalid month: <what was
given> (use YYYY-MM)`. In every other way, the command should work like the others: the same kind of
arguments, checks, errors, exit codes, output and logging.
