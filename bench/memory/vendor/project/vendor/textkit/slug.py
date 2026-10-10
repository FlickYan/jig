import re


def slugify(text):
    """A URL slug: lowercase words joined by hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
