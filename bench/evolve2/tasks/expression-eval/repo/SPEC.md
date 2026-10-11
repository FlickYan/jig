# evaluate(expression, variables=None) -> int, float or bool

Evaluates an expression with Python's arithmetic and logic. `variables` maps names to numbers. Anything
wrong raises `EvalError` (defined in `calc.py`, a subclass of `ValueError`) with one of the messages
below, exactly.

## Tokens

1. Numbers: digits, optionally followed by a fraction (`.` and digits) and then an exponent (`e` or `E`,
   an optional sign, and digits): `42`, `3.14`, `1e3`, `2.5E-1`. A number with a fraction or an exponent
   is a float, and any other an int (leading zeros are allowed: `007` is 7).
2. Names: a letter or `_`, then letters, digits and `_`. Seven of them are keywords, never names: `and`,
   `or`, `not`, `if`, `else`, `True` and `False`.
3. Operators: `+`, `-`, `*`, `/`, `//`, `%`, `**`, `<`, `<=`, `>`, `>=`, `==`, `!=`, `(`, `)` and `,`.
   Spaces and tabs between tokens are ignored.
4. Any other character is an error, `unexpected character 'C' at N`: the character in quotes as Python's
   `repr` writes it, and its index in the expression, counting from 0.

## Grammar

5. From the loosest to the tightest, as in Python: `a if test else b`, from right to left (`1 if a else 2
   if b else 3` is `1 if a else (2 if b else 3)`); `or`; `and`; `not` (so `not 1 == 2` is `not (1 ==
   2)`); the comparisons, which chain (`a < b < c` means `a < b and b < c`, with `b` evaluated once);
   `+` and `-`, from left to right; `*`, `/`, `//` and `%`, from left to right; unary `+` and `-`; `**`,
   from right to left (`2 ** 3 ** 2` is `2 ** 9`); and then numbers, `True` and `False`, names, function
   calls `name(argument, ...)` and parentheses. As in Python, `**` binds tighter than a unary minus on
   its left (`-2 ** 2` is -4), and its right side may begin with one (`2 ** -1` is 0.5).
6. The whole expression is read before anything is evaluated. A token where none can go is an error,
   `unexpected 'T' at N`: the token's text, in quotes as Python's `repr` writes it, and the index of its
   first character. An expression that ends too soon (empty, `1 +`, `(1`, `not`) is `unexpected end`. So
   a syntax error is reported even if evaluating what comes before it would fail.

## Evaluation

7. Evaluation goes from left to right, as in Python, and the first error it meets is raised. Only what
   is needed is evaluated: `and` and `or` evaluate their right side only if their left side doesn't
   decide, and give one of their operands, not a bool (`0 or 5` is 5, `2 and 0` is 0); a chain of
   comparisons stops at the first that is false, without evaluating the rest; and `a if test else b`
   evaluates `test` first, and then only `a` or only `b`. So `0 and 1 / 0` is 0, not an error.
8. Arithmetic is Python's: `/` gives a float; `//` and `%` round down, and `%` takes the divisor's sign;
   ints stay ints, except with `/` and negative exponents. Comparisons and `not` give `True` or `False`,
   which count as 1 and 0 in arithmetic (`True + True` is 2). Dividing by zero with `/`, `//` or `%`, or
   raising zero to a negative power, is `division by zero`. A result that isn't a real number (a negative
   number to a fractional power) is `not a real number`.
9. A name is a variable from `variables`, and one that isn't there is `unknown name 'x'` (the name in
   quotes as Python's `repr` writes it).
10. A name followed by `(` is a call. The functions are `abs(x)`, `min(x, ...)` and `max(x, ...)` (with
    one argument or more: with one, its value) and `round(x)` or `round(x, digits)`, all as in Python
    (`round` takes halves to even: `round(2.5)` is 2). Any other name is `unknown function 'f'`, and the
    wrong number of arguments is `wrong number of arguments to max` (with the function's name). Those two
    checks come before the arguments are evaluated.
