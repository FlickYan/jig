import os

from .dates import today


def record(action, **fields):
    """Appends a line about a change to the audit log, BANK_AUDIT, if it is set. Only changes are recorded."""
    path = os.environ.get("BANK_AUDIT")
    if not path:
        return
    details = " ".join(f"{key}={value}" for key, value in fields.items())
    with open(path, "a") as log:
        log.write(f"{today().isoformat()} {action} {details}\n")
