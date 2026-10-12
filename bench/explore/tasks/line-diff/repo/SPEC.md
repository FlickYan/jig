# diff(old, new)

`old` and `new` are lists of lines (strings). `diff` returns how to turn `old` into `new`: a list of
operations, in order, each one of

- `("keep", line)`: the line is in both,
- `("del", line)`: the line is only in `old`,
- `("add", line)`: the line is only in `new`.

Reading the "keep" and "del" lines in order gives `old`; reading the "keep" and "add" lines gives `new`.

- The list has as few "del" and "add" operations as possible: no shorter list turns `old` into `new`.
- Files have up to 50,000 lines. When `old` and `new` differ in at most 200 lines, `diff` answers
  within 2 seconds.
