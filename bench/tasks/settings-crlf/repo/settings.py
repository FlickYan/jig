"""Read the service's settings file: `key = value` lines, blank lines and `#` comments."""


def parse_settings(text):
    settings = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, value = line.split("=")
        settings[key.strip()] = value.strip()
    return settings


def load_settings(path):
    with open(path, encoding="utf-8") as f:
        return parse_settings(f.read())
