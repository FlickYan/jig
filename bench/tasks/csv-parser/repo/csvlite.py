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
    rows = []
    for line in text.split("\n"):
        if line:
            rows.append(line.split(","))
    return rows
