import argparse
import sys

from app.config import load_settings


def main(argv=None, env=None):
    """Parses the command line over the environment's settings, and returns the settings."""
    parser = argparse.ArgumentParser(prog="app")
    parser.add_argument("--host")
    parser.add_argument("--retry-limit", type=int)
    parser.add_argument("--max-retries", type=int, dest="deprecated_retries", help=argparse.SUPPRESS)
    parser.add_argument("--timeout", type=float)
    args = parser.parse_args(argv)
    settings = load_settings(env=env if env is not None else {})
    if args.host is not None:
        settings.host = args.host
    if args.deprecated_retries is not None:
        print("warning: --max-retries is deprecated; use --retry-limit", file=sys.stderr)
        settings.retry_limit = args.deprecated_retries
    if args.retry_limit is not None:
        settings.retry_limit = args.retry_limit
    if args.timeout is not None:
        settings.timeout = args.timeout
    return settings
