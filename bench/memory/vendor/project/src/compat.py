"""The project's text helpers, built on the vendored textkit."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vendor"))

from textkit.slug import slugify  # noqa: E402

__all__ = ["slugify"]
