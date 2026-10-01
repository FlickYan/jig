"""A small CSV reader for the import tool, which runs where Python's csv module isn't available."""


def parse_csv(text):
    """Parse CSV text into a list of records, each a list of strings.

    - Fields are separated by commas, records by newlines (\\n or \\r\\n).
    - A field may be wrapped in double quotes. Inside quotes, commas and newlines are part of the field
      (newlines are kept exactly as they are), and two double quotes ("") stand for one.
    - A double quote inside a field that does not start with one is an ordinary character.
    - Whitespace is part of the field; nothing is trimmed.
    - Blank lines are skipped, and a newline at the very end does not start another record.
    - A quoted field that is never closed raises ValueError("unterminated quote on line N"), where N is
      the line the field starts on (1-based).
    - After a closing quote, anything other than a comma, a newline or the end of the text raises
      ValueError("unexpected character after quote on line N"), where N is the line of that character.
    """
    rows, row, field = [], [], []
    line, i, n = 1, 0, len(text)
    at_field_start = True

    def end_record():
        nonlocal row
        if row != [""]:  # a blank line
            rows.append(row)
        row = []

    while i < n:
        c = text[i]
        if at_field_start and c == '"':
            start_line, i = line, i + 1
            while True:
                if i >= n:
                    raise ValueError(f"unterminated quote on line {start_line}")
                if text[i] == '"':
                    if i + 1 < n and text[i + 1] == '"':
                        field.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                if text[i] == "\n":
                    line += 1
                field.append(text[i])
                i += 1
            if i < n and text[i] not in ",\r\n":
                raise ValueError(f"unexpected character after quote on line {line}")
            at_field_start = False
            continue
        if c == ",":
            row.append("".join(field))
            field, at_field_start = [], True
        elif c == "\n" or (c == "\r" and text[i + 1 : i + 2] == "\n"):
            row.append("".join(field))
            field, at_field_start = [], True
            end_record()
            line += 1
            i += 1 if c == "\n" else 2
            continue
        else:
            field.append(c)
            at_field_start = False
        i += 1
    if field or not at_field_start or row:
        row.append("".join(field))
        end_record()
    return rows
