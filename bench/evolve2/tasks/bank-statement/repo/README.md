# bank

A small bank's accounts, from the command line.

```
python -m bank open ACCOUNT OWNER
python -m bank deposit ACCOUNT AMOUNT
python -m bank withdraw ACCOUNT AMOUNT
python -m bank transfer SOURCE TARGET AMOUNT
python -m bank balance ACCOUNT
python -m bank history ACCOUNT [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--kind KIND]
```

Accounts are kept in `BANK_DB` (default `bank.json`), and changes are logged to `BANK_AUDIT`.
