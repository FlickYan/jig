import json
import sys

# Exit codes: 2 when the input is wrong (a malformed argument), 1 when it can't be done (an unknown
# account, not enough money).
BAD_INPUT = 2
CANT = 1


def emit(result):
    """A command's result, on stdout."""
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def fail(message, code):
    """An error, on stderr; returns the exit code."""
    print(f"error: {message}", file=sys.stderr)
    return code
