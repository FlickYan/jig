import json
import os
import re

ACCOUNT = re.compile(r"[A-Z]\d{1,6}")


class Unknown(Exception):
    """No such account."""


class Store:
    """The accounts, kept in a JSON file: BANK_DB, or bank.json."""

    def __init__(self):
        self.path = os.environ.get("BANK_DB", "bank.json")
        if os.path.exists(self.path):
            with open(self.path) as file:
                self.data = json.load(file)
        else:
            self.data = {"accounts": {}}

    def save(self):
        with open(self.path, "w") as file:
            json.dump(self.data, file, indent=2, sort_keys=True)

    def account(self, account_id):
        """An account's record; the id must be valid (check_id) and the account must exist."""
        if account_id not in self.data["accounts"]:
            raise Unknown(f"unknown account: {account_id}")
        return self.data["accounts"][account_id]

    @staticmethod
    def balance(record):
        return sum(transaction["amount"] for transaction in record["transactions"])


def check_id(account_id):
    if not ACCOUNT.fullmatch(account_id):
        raise ValueError(f"invalid account: {account_id}")
