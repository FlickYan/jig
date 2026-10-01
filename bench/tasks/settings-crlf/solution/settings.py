"""Read the service's settings file: `key = value` lines, blank lines and `#` comments."""


def parse_settings(text):
    settings = {}
    for number, line in enumerate(text.splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"line {number}: expected key = value")
        key, value = line.split("=", 1)
        settings[key.strip()] = value.strip()
    return settings


def load_settings(path):
    with open(path, encoding="utf-8") as f:
        return parse_settings(f.read())
