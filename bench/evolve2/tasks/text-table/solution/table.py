"""A text table for a list of dicts. See SPEC.md."""
import unicodedata

ALIGNMENTS = ("left", "right", "center")


def width(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1 for c in text)


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _cell(value, points):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, float):
        return format(value, ".2f")
    if isinstance(value, int) and points:
        return f"{value}   "
    return str(value)


def _cut(text, room):
    if width(text) <= room:
        return text
    kept = ""
    for char in text:
        if width(kept + char) > room - 1:
            break
        kept += char
    return kept + "…"


def render(rows, columns=None, max_width=None, align=None, totals=False):
    if columns is None:
        columns = []
        for row in rows:
            for key in row:
                if key not in columns:
                    columns.append(key)
    if not columns:
        return ""
    align = dict(align or {})
    for column, how in align.items():
        if column not in columns or how not in ALIGNMENTS:
            raise ValueError(f"can't align {column!r} {how!r}")
    numeric, points = [], []
    for column in columns:
        values = [row.get(column) for row in rows if row.get(column) is not None]
        numeric.append(bool(values) and all(_number(v) for v in values))
        points.append(numeric[-1] and any(isinstance(v, float) for v in values))
    cells = [[_cell(row.get(column), points[i]) for i, column in enumerate(columns)] for row in rows]
    total_cells = None
    if totals:
        total_cells = []
        for i, column in enumerate(columns):
            if numeric[i]:
                total = sum(row.get(column) for row in rows if row.get(column) is not None)
                total_cells.append(_cell(float(total) if points[i] else total, points[i]))
            else:
                total_cells.append("Total" if i == 0 else "")
    lines_of_cells = cells + ([total_cells] if total_cells else [])
    widths = [max([width(str(column))] + [width(line[i]) for line in lines_of_cells]) for i, column in enumerate(columns)]
    if max_width is not None:
        while sum(widths) + 2 * (len(widths) - 1) > max_width:
            candidates = [i for i in range(len(widths)) if not numeric[i] and widths[i] > 3]
            if not candidates:
                raise ValueError(f"the table can't be made {max_width} wide")
            widest = max(widths[i] for i in candidates)
            widths[max(i for i in candidates if widths[i] == widest)] -= 1
    how = [align.get(column, "right" if numeric[i] else "left") for i, column in enumerate(columns)]

    def line(texts):
        parts = []
        for i, text in enumerate(texts):
            text = _cut(text, widths[i])
            pad = widths[i] - width(text)
            if how[i] == "right":
                parts.append(" " * pad + text)
            elif how[i] == "center":
                parts.append(" " * (pad // 2) + text + " " * (pad - pad // 2))
            else:
                parts.append(text + " " * pad)
        return "  ".join(parts).rstrip()

    out = [line([str(column) for column in columns]), line(["-" * w for w in widths])]
    out += [line(texts) for texts in cells]
    if total_cells:
        out += [line(["=" * w for w in widths]), line(total_cells)]
    return "\n".join(out) + "\n"
