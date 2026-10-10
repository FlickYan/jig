# Roman numerals

`to_roman(n)` returns the Roman numeral for `n`, and `from_roman(text)` the number a numeral stands for.

1. `to_roman` takes an integer from 1 to 3999 and returns its numeral in standard form, using
   I V X L C D M and the subtractive pairs IV, IX, XL, XC, CD and CM: 1994 is `MCMXCIV`. Anything else
   (0, negative numbers, 4000 and above, booleans, floats, strings) raises `ValueError`.
2. `from_roman` accepts upper or lower case, and ignores leading and trailing whitespace.
3. `from_roman` accepts only numerals in standard form: exactly what `to_roman` would produce for some
   number. So `IIII`, `VV`, `IC`, `IL`, `XM`, `IIV`, `VX`, `XCX`, `IXIX` and `MMMM` are all rejected,
   as is anything empty or with other characters.
4. Rejected input raises `ValueError` with a message that contains the input.
