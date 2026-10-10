import re

REFERENCE = re.compile(r"\$\{(?:([^:}]+):)?([^}]+)\}")


def _value(raw, number):
    raw = raw.strip()
    if raw.startswith('"'):
        out, i = [], 1
        while i < len(raw):
            ch = raw[i]
            if ch == "\\" and i + 1 < len(raw) and raw[i + 1] in '"\\':
                out.append(raw[i + 1])
                i += 2
                continue
            if ch == '"':
                rest = raw[i + 1:].strip()
                if rest and not rest.startswith(("#", ";")):
                    raise ValueError(f"line {number}: text after a quoted value")
                return "".join(out)
            out.append(ch)
            i += 1
        raise ValueError(f"line {number}: unclosed quote")
    match = re.search(r"\s[#;]", raw)
    return (raw[: match.start()] if match else raw).strip()


def parse(text):
    """An INI file as {section: {key: value}}. See SPEC.md."""
    sections = {}
    section = "default"
    last = None
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            last = None
            continue
        if line.lstrip().startswith(("#", ";")):
            last = None
            continue
        if line[0] in " \t":
            if last is None:
                raise ValueError(f"line {number}: a continuation with nothing to continue")
            sec, key = last
            addition = _value(line, number)
            sections[sec][key] = f"{sections[sec][key]} {addition}".strip() if sections[sec][key] else addition
            continue
        header = re.fullmatch(r"\[\s*([^\]]+?)\s*\]\s*", line)
        if header:
            section = header.group(1).lower()
            sections.setdefault(section, {})
            last = None
            continue
        pair = re.fullmatch(r"([^=:]+?)\s*[=:]\s?(.*)", line)
        if not pair or not pair.group(1).strip():
            raise ValueError(f"line {number}: not a section, key or comment: {line!r}")
        key = pair.group(1).strip().lower()
        sections.setdefault(section, {})[key] = _value(pair.group(2), number)
        last = (section, key)

    def resolve(sec, key, seen):
        if (sec, key) in seen:
            raise ValueError(f"a cycle of references through {sec}:{key}")
        if sec not in sections or key not in sections[sec]:
            raise ValueError(f"a reference to {sec}:{key}, which isn't defined")
        return REFERENCE.sub(lambda m: resolve(m.group(1).lower() if m.group(1) else sec, m.group(2).strip().lower(), seen | {(sec, key)}), sections[sec][key])

    return {sec: {key: resolve(sec, key, frozenset()) for key in keys} for sec, keys in sections.items()}
