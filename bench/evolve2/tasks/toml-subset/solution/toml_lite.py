"""A parser for the part of TOML described in SPEC.md."""
import re
from datetime import date, datetime, time, timedelta, timezone


class TOMLError(ValueError):
    """The document isn't valid TOML (in the part of TOML this module reads)."""


BARE_KEY = re.compile(r"[A-Za-z0-9_-]+")
DIGITS = r"[0-9](?:_?[0-9])*"
DECIMAL = re.compile(r"[+-]?(?:0|[1-9](?:_?[0-9])*)")
FLOAT = re.compile(rf"[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\.{DIGITS})?(?:[eE][+-]?{DIGITS})?")
PREFIXED = {"0x": (16, re.compile(r"[0-9A-Fa-f](?:_?[0-9A-Fa-f])*")), "0o": (8, re.compile(r"[0-7](?:_?[0-7])*")), "0b": (2, re.compile(r"[01](?:_?[01])*"))}
DATE = r"(\d{4})-(\d{2})-(\d{2})"
TIME = r"(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?"
MOMENT = re.compile(rf"{DATE}(?:[Tt ]{TIME}([Zz]|[+-]\d{{2}}:\d{{2}})?)?|{TIME}")
ESCAPES = {"b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r", '"': '"', "\\": "\\"}

# How each table came to be: decides what may still be added to it, and how.
IMPLICIT, HEADER, DOTTED, FROZEN = "implicit", "header", "dotted", "frozen"


def loads(text):
    return _Parser(text).parse()


class _Parser:
    def __init__(self, text):
        if re.search(r"\r(?!\n)", text):
            raise TOMLError("a carriage return must be followed by a newline")
        self.s = text.replace("\r\n", "\n")
        self.i = 0
        self.root = {}
        self.kinds = {id(self.root): HEADER}
        self.arrays = set()  # ids of the lists that are arrays of tables

    def error(self, message):
        line = self.s.count("\n", 0, self.i) + 1
        raise TOMLError(f"{message} (line {line})")

    def peek(self, length=1):
        return self.s[self.i:self.i + length]

    def skip_spaces(self):
        while self.peek() in (" ", "\t") and self.peek():
            self.i += 1

    def skip_comment(self):
        if self.peek() == "#":
            end = self.s.find("\n", self.i)
            self.i = len(self.s) if end == -1 else end

    def end_of_line(self):
        self.skip_spaces()
        self.skip_comment()
        if self.i < len(self.s):
            if self.peek() != "\n":
                self.error("expected the end of the line")
            self.i += 1

    def parse(self):
        table = self.root
        while self.i < len(self.s):
            self.skip_spaces()
            char = self.peek()
            if char in ("\n", "#", ""):
                self.end_of_line()
            elif char == "[":
                table = self.header()
                self.end_of_line()
            else:
                self.key_value(table)
                self.end_of_line()
        return self.root

    # Keys and headers

    def key(self):
        parts = []
        while True:
            self.skip_spaces()
            char = self.peek()
            if char == '"':
                parts.append(self.basic_string())
            elif char == "'":
                parts.append(self.literal_string())
            else:
                match = BARE_KEY.match(self.s, self.i)
                if not match:
                    self.error("expected a key")
                parts.append(match.group())
                self.i = match.end()
            self.skip_spaces()
            if self.peek() != ".":
                return parts
            self.i += 1

    def header(self):
        array = self.peek(2) == "[["
        self.i += 2 if array else 1
        path = self.key()
        if self.peek(2 if array else 1) != ("]]" if array else "]"):
            self.error("expected the end of the header")
        self.i += 2 if array else 1
        table = self.root
        for part in path[:-1]:
            table = self.descend(table, part)
        last = path[-1]
        current = table.get(last)
        if array:
            if current is None:
                current = table[last] = []
                self.arrays.add(id(current))
            elif not (isinstance(current, list) and id(current) in self.arrays):
                self.error(f"{last} isn't an array of tables")
            element = {}
            self.kinds[id(element)] = HEADER
            current.append(element)
            return element
        if current is None:
            current = table[last] = {}
        elif not isinstance(current, dict) or self.kinds[id(current)] != IMPLICIT:
            self.error(f"{last} is already defined")
        self.kinds[id(current)] = HEADER
        return current

    def descend(self, table, part):
        """The table a header passes through on its way to the one it names."""
        current = table.get(part)
        if current is None:
            current = table[part] = {}
            self.kinds[id(current)] = IMPLICIT
            return current
        if isinstance(current, list) and id(current) in self.arrays:
            return current[-1]
        if isinstance(current, dict) and self.kinds[id(current)] != FROZEN:
            return current
        self.error(f"{part} can't be extended")

    def key_value(self, table):
        path = self.key()
        if self.peek() != "=":
            self.error("expected =")
        self.i += 1
        self.skip_spaces()
        value = self.value()
        self.assign(table, path, value)

    def assign(self, table, path, value):
        for part in path[:-1]:
            current = table.get(part)
            if current is None:
                current = table[part] = {}
                self.kinds[id(current)] = DOTTED
            elif not isinstance(current, dict) or self.kinds[id(current)] in (HEADER, FROZEN):
                self.error(f"{part} can't be extended with a dotted key")
            table = current
        if path[-1] in table:
            self.error(f"{path[-1]} is already defined")
        table[path[-1]] = value

    # Values

    def value(self):
        char = self.peek()
        if self.peek(3) in ('"""', "'''"):
            return self.multiline_string()
        if char == '"':
            return self.basic_string()
        if char == "'":
            return self.literal_string()
        if char == "[":
            return self.array()
        if char == "{":
            return self.inline_table()
        moment = MOMENT.match(self.s, self.i)
        if moment and (moment.end() == len(self.s) or self.s[moment.end()] in " \t\n,]}#"):
            self.i = moment.end()
            return self.moment(moment)
        match = re.compile(r"[^\s,\]\}#]+").match(self.s, self.i)
        if not match:
            self.error("expected a value")
        self.i = match.end()
        return self.scalar(match.group())

    def scalar(self, token):
        if token in ("true", "false"):
            return token == "true"
        if re.fullmatch(r"[+-]?(inf|nan)", token):
            return float(token)
        prefix = token[:2]
        if prefix in PREFIXED:
            base, digits = PREFIXED[prefix]
            if digits.fullmatch(token, 2):
                return int(token[2:].replace("_", ""), base)
            self.error(f"invalid number {token}")
        if DECIMAL.fullmatch(token):
            return int(token.replace("_", ""))
        if FLOAT.fullmatch(token):
            return float(token.replace("_", ""))
        self.error(f"invalid value {token}")

    def moment(self, match):
        """A date, a time, or a date and time, with or without an offset."""
        year, month, day, hour, minute, second, fraction, offset, t_hour, t_minute, t_second, t_fraction = match.groups()
        try:
            if year is None:
                return time(int(t_hour), int(t_minute), int(t_second), _micro(t_fraction))
            if hour is None:
                return date(int(year), int(month), int(day))
            zone = None
            if offset:
                if offset in "Zz":
                    zone = timezone.utc
                else:
                    sign = -1 if offset[0] == "-" else 1
                    hours, minutes = int(offset[1:3]), int(offset[4:6])
                    if hours > 23 or minutes > 59:
                        raise ValueError(offset)
                    zone = timezone(sign * timedelta(hours=hours, minutes=minutes))
            return datetime(int(year), int(month), int(day), int(hour), int(minute), int(second), _micro(fraction), tzinfo=zone)
        except ValueError:
            self.error(f"invalid date or time {match.group()}")

    def multiline_string(self):
        quote = self.peek()
        self.i += 3
        if self.peek() == "\n":
            self.i += 1
        out = []
        while True:
            if self.i >= len(self.s):
                self.error("unterminated string")
            if self.s.startswith(quote * 3, self.i):
                run = 3
                while self.s.startswith(quote, self.i + run):
                    run += 1
                if run > 5:
                    self.error("too many quotes")
                out.append(quote * (run - 3))
                self.i += run
                return "".join(out)
            char = self.s[self.i]
            if char != "\\" or quote == "'":
                out.append(char)
                self.i += 1
                continue
            after = re.compile(r"[ \t]*\n").match(self.s, self.i + 1)
            if after:
                self.i = after.end()
                while self.peek() in (" ", "\t", "\n") and self.peek():
                    self.i += 1
                continue
            self.i += 1
            out.append(self.escape())

    def escape(self):
        """The character an escape after a backslash stands for."""
        escape = self.peek()
        self.i += 1
        if escape in ESCAPES:
            return ESCAPES[escape]
        if escape in ("u", "U"):
            length = 4 if escape == "u" else 8
            digits = self.s[self.i:self.i + length]
            if not re.fullmatch(rf"[0-9A-Fa-f]{{{length}}}", digits):
                self.error("invalid unicode escape")
            code = int(digits, 16)
            if 0xD800 <= code <= 0xDFFF or code > 0x10FFFF:
                self.error("not a unicode scalar value")
            self.i += length
            return chr(code)
        self.error(f"invalid escape \\{escape}")

    def basic_string(self):
        self.i += 1
        out = []
        while True:
            char = self.peek()
            if char in ("", "\n"):
                self.error("unterminated string")
            self.i += 1
            if char == '"':
                return "".join(out)
            if char != "\\":
                out.append(char)
                continue
            out.append(self.escape())

    def literal_string(self):
        end = self.s.find("'", self.i + 1)
        newline = self.s.find("\n", self.i + 1)
        if end == -1 or (newline != -1 and newline < end):
            self.error("unterminated string")
        text = self.s[self.i + 1:end]
        self.i = end + 1
        return text

    def skip_blank(self):
        """Spaces, newlines and comments, as allowed inside an array."""
        while True:
            self.skip_spaces()
            self.skip_comment()
            if self.peek() == "\n":
                self.i += 1
            else:
                return

    def array(self):
        self.i += 1
        items = []
        while True:
            self.skip_blank()
            if self.peek() == "]":
                self.i += 1
                break
            items.append(self.value())
            self.skip_blank()
            if self.peek() == ",":
                self.i += 1
            elif self.peek() == "]":
                self.i += 1
                break
            else:
                self.error("expected , or ] in an array")
        self.freeze(items)
        return items

    def inline_table(self):
        self.i += 1
        table = {}
        self.kinds[id(table)] = DOTTED  # dotted keys inside it may build it up, until it is closed
        self.skip_spaces()
        if self.peek() == "}":
            self.i += 1
        else:
            while True:
                self.key_value(table)
                self.skip_spaces()
                if self.peek() == ",":
                    self.i += 1
                    continue
                if self.peek() == "}":
                    self.i += 1
                    break
                self.error("expected , or } in an inline table")
        self.freeze(table)
        return table

    def freeze(self, value):
        if isinstance(value, dict):
            self.kinds[id(value)] = FROZEN
            for item in value.values():
                self.freeze(item)
        elif isinstance(value, list):
            for item in value:
                self.freeze(item)


def _micro(fraction):
    """Microseconds from the digits after the point: the first six, the rest dropped."""
    return int((fraction or "").ljust(6, "0")[:6])
