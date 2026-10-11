"""Whether git would ignore a path, given the repository's .gitignore files. See SPEC.md."""
import re


def is_ignored(path, gitignores, is_dir=False):
    # Root first, deepest last: with the last match deciding, deeper files take precedence.
    files = sorted(
        ((directory, [rule for rule in map(_parse, lines) if rule]) for directory, lines in gitignores.items()),
        key=lambda item: 0 if item[0] == "" else item[0].count("/") + 1,
    )
    parts = path.split("/")
    # Directories from the top down: one that is ignored hides everything in it.
    for depth in range(1, len(parts)):
        if _last_match(files, "/".join(parts[:depth]), True):
            return True
    return _last_match(files, path, is_dir)


def _last_match(files, path, is_dir):
    ignored = False
    for directory, rules in files:
        if directory and not path.startswith(directory + "/"):
            continue
        relative = path[len(directory) + 1:] if directory else path
        for regex, negated, dir_only in rules:
            if (is_dir or not dir_only) and regex.fullmatch(relative):
                ignored = not negated
    return ignored


def _parse(line):
    """A pattern as (regex, negated, dir_only), or None for a blank line or a comment."""
    while line.endswith(" ") and not line.endswith("\\ "):
        line = line[:-1]
    if not line or line.startswith("#"):
        return None
    negated = line.startswith("!")
    if negated:
        line = line[1:]
    dir_only = line.endswith("/")
    if dir_only:
        line = line[:-1]
    anchored = "/" in line
    if line.startswith("/"):
        line = line[1:]
    regex = _translate(line)
    if not anchored:
        regex = "(?:.*/)?" + regex
    return re.compile(regex, re.DOTALL), negated, dir_only


def _translate(pattern):
    parts = pattern.split("/")
    out = ""
    for index, part in enumerate(parts):
        if part == "**":
            if index == len(parts) - 1:
                out += "/.+" if out else ".+"
            else:
                out += "/(?:.*/)?" if out else "(?:.*/)?"
            continue
        if out and not out.endswith("/)?"):
            out += "/"
        out += _component(part)
    return out


def _component(text):
    out = ""
    i = 0
    while i < len(text):
        char = text[i]
        if char == "\\" and i + 1 < len(text):
            out += re.escape(text[i + 1])
            i += 2
            continue
        if char == "*":
            while i + 1 < len(text) and text[i + 1] == "*":
                i += 1
            out += "[^/]*"
        elif char == "?":
            out += "[^/]"
        elif char == "[" and "]" in text[i + 2:]:
            end = text.index("]", i + 2)
            body = text[i + 1:end]
            negate = body.startswith("!")
            if negate:
                body = body[1:]
            body = body.replace("\\", "\\\\")
            out += f"(?!/)[{'^' if negate else ''}{body}]"
            i = end
        else:
            out += re.escape(char)
        i += 1
    return out
