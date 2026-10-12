"""Settings, in this order, each overriding the one before:

1. syncer/settings/defaults.toml
2. syncer/settings/environments/<APP_ENV>.toml, if APP_ENV is set
3. environment variables SYNCER_<NAME>, like SYNCER_RETRIES=5

Every setting is declared in schema.py, with its type and a check, so that a typo or a bad value
stops the program at start instead of later.
"""
import os
import tomllib

from syncer.settings.schema import SCHEMA

HERE = os.path.dirname(os.path.abspath(__file__))


def _read(path):
    if not os.path.exists(path):
        return {}
    with open(path, "rb") as f:
        return tomllib.load(f)


def load(environ=None):
    """The settings in effect, as a dict."""
    environ = os.environ if environ is None else environ
    values = _read(os.path.join(HERE, "defaults.toml"))
    if environ.get("APP_ENV"):
        values.update(_read(os.path.join(HERE, "environments", f"{environ['APP_ENV']}.toml")))
    for name in SCHEMA:
        if f"SYNCER_{name.upper()}" in environ:
            values[name] = environ[f"SYNCER_{name.upper()}"]
    settings = {}
    for name, value in values.items():
        if name not in SCHEMA:
            raise ValueError(f"unknown setting {name!r}")
        kind, check, wanted = SCHEMA[name]
        try:
            value = kind(value)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be {wanted}, not {value!r}") from None
        if not check(value):
            raise ValueError(f"{name} must be {wanted}, not {value!r}")
        settings[name] = value
    return settings
