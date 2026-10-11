class PatchError(ValueError):
    """The patch can't be applied: nothing of it was."""


def apply_patch(document, patch):
    """The document with the JSON Patch applied. See SPEC.md."""
    raise NotImplementedError


def diff(source, target):
    """A JSON Patch that turns source into target. See SPEC.md."""
    raise NotImplementedError
