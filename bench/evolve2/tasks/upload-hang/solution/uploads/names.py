import re

# A name: letters and digits, with single separators between them (and maybe one before the
# extension), then an extension we accept. Each repetition starts with its separator, so there is
# only one way to match a name, and a name that doesn't match fails at once.
NAME = re.compile(r"^[a-zA-Z0-9]+(?:[-_. ][a-zA-Z0-9]+)*[-_. ]?\.(txt|csv|json|png|jpg)$")


def is_valid_name(name):
    return NAME.match(name) is not None
