import re

VERSION = re.compile(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")
PARTIAL = re.compile(r"v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?")


def parse_version(text):
    match = VERSION.fullmatch(text.strip())
    if not match:
        raise ValueError(f"not a version: {text!r}")
    major, minor, patch, pre, _build = match.groups()
    return (int(major), int(minor), int(patch), tuple(pre.split(".")) if pre else ())


def compare(a, b):
    if a[:3] != b[:3]:
        return -1 if a[:3] < b[:3] else 1
    pa, pb = a[3], b[3]
    if pa == pb:
        return 0
    if not pa:
        return 1
    if not pb:
        return -1
    for x, y in zip(pa, pb):
        if x == y:
            continue
        xn, yn = x.isdigit(), y.isdigit()
        if xn and yn:
            return -1 if int(x) < int(y) else 1
        if xn != yn:
            return -1 if xn else 1
        return -1 if x < y else 1
    return -1 if len(pa) < len(pb) else 1


def _comparators(token):
    """One token of a comparator set, as (operator, version) pairs."""
    match = re.fullmatch(r"(\^|~|>=|<=|>|<|=)?(.*)", token)
    op, rest = match.groups()
    if not rest:
        raise ValueError(f"not a range: {token!r}")
    partial = PARTIAL.fullmatch(rest)
    if not partial:
        raise ValueError(f"not a range: {token!r}")
    parts = [None if p is None or p in "xX*" else int(p) for p in partial.groups()[:3]]
    pre = tuple(partial.group(4).split(".")) if partial.group(4) else ()
    major, minor, patch = parts
    if major is None:
        if op in ("^", "~", None, "=", ">=", "<="):
            return []
        raise ValueError(f"not a range: {token!r}")
    if minor is None and parts[2] is not None or (pre and None in parts):
        raise ValueError(f"not a range: {token!r}")
    low = (major, minor or 0, patch or 0, pre)
    if op == "^":
        if major > 0 or minor is None:
            high = (major + 1, 0, 0, ("0",))
        elif minor > 0 or patch is None:
            high = (0, minor + 1, 0, ("0",))
        else:
            high = (0, 0, patch + 1, ("0",))
        return [(">=", low), ("<", high)]
    if op == "~":
        high = (major + 1, 0, 0, ("0",)) if minor is None else (major, minor + 1, 0, ("0",))
        return [(">=", low), ("<", high)]
    if minor is None or patch is None:
        high = (major + 1, 0, 0, ("0",)) if minor is None else (major, minor + 1, 0, ("0",))
        if op in (None, "="):
            return [(">=", low), ("<", high)]
        if op == ">":
            return [(">=", high)]
        if op == "<=":
            return [("<", high)]
        return [(op, low)]
    return [(op or "=", low)]


def satisfies(version, range_):
    """Whether `version` satisfies `range_`, npm-style. See SPEC.md."""
    v = parse_version(version)
    parsed = []
    texts = range_.split("||")
    for text in texts:
        if not text.strip() and len(texts) > 1:
            raise ValueError(f"not a range: {range_!r}")
        parsed.append([c for token in text.split() for c in _comparators(token)])
    for comparators in parsed:
        # A pre-release only matches a set that names a pre-release of the same major.minor.patch.
        if v[3] and not any(bound[3] and bound[3] != ("0",) and bound[:3] == v[:3] for _, bound in comparators):
            continue
        if all({"=": c == 0, ">": c > 0, ">=": c >= 0, "<": c < 0, "<=": c <= 0}[op] for op, c in ((op, compare(v, bound)) for op, bound in comparators)):
            return True
    return False
