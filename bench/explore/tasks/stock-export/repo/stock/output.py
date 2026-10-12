import json


def emit(result, args):
    """Prints what a command returned: JSON with --json; otherwise a list of rows as a table, and
    anything else as `key: value` lines."""
    if args.json:
        print(json.dumps(result, sort_keys=True))
    elif isinstance(result, list):
        if result:
            keys = list(result[0])
            widths = [max(len(str(k)), *(len(str(row[k])) for row in result)) for k in keys]
            print("  ".join(str(k).ljust(w) for k, w in zip(keys, widths)).rstrip())
            for row in result:
                print("  ".join(str(row[k]).ljust(w) for k, w in zip(keys, widths)).rstrip())
    else:
        for key, value in result.items():
            print(f"{key}: {value}")
