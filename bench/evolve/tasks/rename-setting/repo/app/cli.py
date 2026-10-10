import argparse

from app.config import load_settings


def main(argv=None, env=None):
    """Parses the command line over the environment's settings, and returns the settings."""
    parser = argparse.ArgumentParser(prog="app")
    parser.add_argument("--host")
    parser.add_argument("--max-retries", type=int)
    parser.add_argument("--timeout", type=float)
    args = parser.parse_args(argv)
    settings = load_settings(env=env if env is not None else {})
    if args.host is not None:
        settings.host = args.host
    if args.max_retries is not None:
        settings.max_retries = args.max_retries
    if args.timeout is not None:
        settings.timeout = args.timeout
    return settings
