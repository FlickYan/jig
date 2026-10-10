# parse(text) -> dict

Parses an INI file into `{section: {key: value}}`, all values strings.

1. `[name]` starts a section. Section names are case-insensitive and stored in lower case; spaces
   around the name inside the brackets are ignored. Keys before the first section go in `"default"`.
2. `key = value` and `key: value` both work. Keys are case-insensitive and stored in lower case;
   whitespace around keys and values is ignored. A key can't be empty: `= value` is an error.
3. A line whose first non-blank character is `#` or `;` is a comment. In a value, ` #` or ` ;` (the
   character after whitespace) starts a comment that runs to the end of the line.
4. A value in double quotes keeps everything inside them, `#` and `;` and spaces included, and the
   quotes are removed. Inside quotes, `\"` is a quote and `\\` a backslash.
5. A line that starts with whitespace continues the value on the line before it: the two are joined
   with a single space. Blank lines and comments in between end the value.
6. If a key appears twice in a section, the last value wins. A section that appears twice is one
   section, its keys merged.
7. `key =` with nothing after it is the empty string.
8. `${key}` in a value is replaced by that key's value in the same section, and `${section:key}` by
   a key in another section, after the whole file is read (so a key may refer to one defined later).
   A reference to a key that doesn't exist, or a cycle of references, raises `ValueError`.
9. Any other line raises `ValueError` with a message that names its line number (counting from 1).
