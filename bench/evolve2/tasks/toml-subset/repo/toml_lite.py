class TOMLError(ValueError):
    """The document isn't valid TOML (in the part of TOML this module reads)."""


def loads(text):
    """A TOML document as a dict. See SPEC.md."""
    raise NotImplementedError
