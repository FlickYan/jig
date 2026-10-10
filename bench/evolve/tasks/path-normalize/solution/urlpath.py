import re

UNRESERVED = re.compile(r"[A-Za-z0-9._~-]")


def _decode_unreserved(path):
    def fix(match):
        char = chr(int(match.group(1), 16))
        return char if UNRESERVED.fullmatch(char) else f"%{match.group(1).upper()}"
    if re.search(r"%(?![0-9A-Fa-f]{2})", path):
        raise ValueError(f"a bad percent-escape in {path!r}")
    return re.sub(r"%([0-9A-Fa-f]{2})", fix, path)


def normalize(path):
    """The normalized form of a URL path. See SPEC.md."""
    decoded = _decode_unreserved(path)
    segments = [s for s in decoded.split("/")]
    trailing = decoded.endswith("/") or segments[-1] in (".", "..")
    out = []
    for segment in segments:
        if segment in ("", "."):
            continue
        if segment == "..":
            if out:
                out.pop()
            continue
        out.append(segment)
    result = "/" + "/".join(out)
    if trailing and out:
        result += "/"
    return result
