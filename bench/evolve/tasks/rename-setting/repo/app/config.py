import os
from dataclasses import dataclass, fields


@dataclass
class Settings:
    host: str = "localhost"
    max_retries: int = 3
    timeout: float = 10.0


def load_yaml(path):
    """The flat `key: value` pairs of a config file, numbers converted."""
    values = {}
    with open(path) as handle:
        for line in handle:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            key, _, value = line.partition(":")
            value = value.strip()
            for kind in (int, float):
                try:
                    value = kind(value)
                    break
                except ValueError:
                    pass
            values[key.strip()] = value
    return values


def load_settings(env=None, file_values=None):
    """Settings from a config file's values, then the environment (APP_HOST, APP_MAX_RETRIES, APP_TIMEOUT)."""
    env = os.environ if env is None else env
    known = {f.name for f in fields(Settings)}
    settings = Settings(**{k: v for k, v in (file_values or {}).items() if k in known})
    if "APP_HOST" in env:
        settings.host = env["APP_HOST"]
    if "APP_MAX_RETRIES" in env:
        settings.max_retries = int(env["APP_MAX_RETRIES"])
    if "APP_TIMEOUT" in env:
        settings.timeout = float(env["APP_TIMEOUT"])
    return settings
