import re

ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
TAG = re.compile(r"\{\{!--.*?--\}\}|\{\{\{(.*?)\}\}\}|\{\{(.*?)\}\}", re.S)
MISSING = object()


def _lookup(context, dotted):
    value = context
    for part in dotted.split("."):
        if isinstance(value, dict):
            value = value.get(part, MISSING)
        else:
            value = getattr(value, part, MISSING)
        if value is MISSING:
            return MISSING
    return value


def _text(value):
    if value is MISSING or value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _apply(value, spec):
    name, _, argument = spec.strip().partition(":")
    name = name.strip()
    if name == "upper":
        return _text(value).upper()
    if name == "lower":
        return _text(value).lower()
    if name == "default":
        match = re.fullmatch(r'\s*"(.*)"\s*', argument)
        if not match:
            raise ValueError(f"default needs a quoted argument: {spec!r}")
        return match.group(1) if value is MISSING or value is None or value == "" else value
    if name == "truncate":
        if not argument.strip().isdigit():
            raise ValueError(f"truncate needs a number: {spec!r}")
        limit = int(argument)
        text = _text(value)
        return text if len(text) <= limit else text[: limit - 1] + "…"
    raise ValueError(f"unknown filter {name!r}")


def _expression(body):
    name, *filters = body.split("|")
    value = _lookup(CONTEXT[-1], name.strip())
    for spec in filters:
        value = _apply(value, spec)
    return _text(value)


CONTEXT = []


def render(template, context):
    """The template with its {{ }} tags filled in from context. See SPEC.md."""
    CONTEXT.append(context)
    try:
        out, position = [], 0
        for match in TAG.finditer(template):
            out.append(template[position:match.start()])
            raw, escaped = match.group(1), match.group(2)
            if raw is not None:
                out.append(_expression(raw))
            elif escaped is not None:
                if escaped.startswith("{") or "{{" in escaped:
                    raise ValueError(f"a malformed tag: {match.group(0)!r}")
                out.append("".join(ESCAPES.get(ch, ch) for ch in _expression(escaped)))
            position = match.end()
        rest = template[position:]
        if "{{" in rest:
            raise ValueError("an unclosed {{")
        out.append(rest)
        return "".join(out)
    finally:
        CONTEXT.pop()
