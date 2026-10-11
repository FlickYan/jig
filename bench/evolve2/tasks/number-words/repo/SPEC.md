# Numbers in words

`to_words(n)`, `to_ordinal(n)` and `from_words(text)`, in `words.py`, write and read whole numbers in
English words, and `to_cheque(amount)` writes an amount of money as a cheque does.

## to_words(n, style="us")

1. `n` is an `int` from -999,999,999,999,999 to 999,999,999,999,999; a larger one raises `ValueError`,
   and anything that isn't an `int` raises `TypeError` (`True` and `False` aren't numbers here). `style`
   is `"us"` (the default) or `"uk"`; any other raises `ValueError`.
2. 0 is `zero`, and a negative number is `minus` and the words for its absolute value.
3. 1 to 19 are `one`, `two`, `three`, `four`, `five`, `six`, `seven`, `eight`, `nine`, `ten`, `eleven`,
   `twelve`, `thirteen`, `fourteen`, `fifteen`, `sixteen`, `seventeen`, `eighteen` and `nineteen`. The
   tens are `twenty`, `thirty`, `forty`, `fifty`, `sixty`, `seventy`, `eighty` and `ninety`; from 21 to
   99, a number that isn't a ten joins its ten and its unit with a hyphen: `forty-two`.
4. From 100 to 999: the hundreds digit, `hundred`, and then the rest unless it is zero: `three hundred`,
   `three hundred five`, `three hundred forty-two`. In US style there is never an `and`.
5. Larger numbers are written in groups of three digits from the left, each followed by its scale:
   `thousand`, `million`, `billion` and `trillion` (10^3, 10^6, 10^9 and 10^12). A group that is zero is
   left out: 1000001 is `one million one`, and 1234567 is `one million two hundred thirty-four thousand
   five hundred sixty-seven`. So 1100 is `one thousand one hundred`, never `eleven hundred`.
6. Words are separated by single spaces, and are all lower-case.
7. In UK style, the words are the same with `and` in two places: after `hundred` when the rest of its
   group of three digits isn't zero (`one hundred and five`, `three hundred and forty-two thousand`), and
   before the last group when it is less than 100 and there is a group above it (`one thousand and
   five`, `two million and fifty`). So 1105 is `one thousand one hundred and five`, and 1100 is still
   `one thousand one hundred`.

## to_ordinal(n, style="us")

8. For an `int` from 0 to 999,999,999,999,999 (`TypeError` and `ValueError` as in rule 1, and
   `ValueError` for a negative number too): the words for `n` in the style, with the last word made
   ordinal. `one` becomes `first`, `two` `second`, `three` `third`, `five` `fifth`, `eight` `eighth`,
   `nine` `ninth`, and `twelve` `twelfth`; a word ending in `y` ends in `ieth` instead (`twenty`,
   `twentieth`); any other word gets `th` (`fourth`, `eleventh`, `zeroth`, `hundredth`, `thousandth`,
   `millionth`). In a word with a hyphen, only the part after the hyphen changes: `forty-second`.

## from_words(text, style="us")

9. The number `to_words` writes as exactly `text` in that style. Any other text raises `ValueError`,
   however close it is: other spaces, capitals, a missing or extra hyphen or `and`, a misspelling, or a
   number out of range. A `text` that isn't a string raises `TypeError`, and a style as in rule 1.

## to_cheque(amount)

10. The amount in US-style words, as written on a cheque: the dollars in words, then `dollar` (for one)
    or `dollars`, then `and`, then the cents in words with `cent` (for one) or `cents`, or else `no
    cents`: `one thousand two hundred thirty-four dollars and fifty cents`, `one dollar and no cents`,
    `zero dollars and one cent`.
11. The amount is an `int` (of dollars), a `Decimal`, or a string of digits, optionally with a `.` and
    one or two more digits (`"1234.5"` is $1,234.50). It must be at least 0 and less than 10^15 dollars,
    with no fraction of a cent. A float raises `TypeError`, since it isn't exact, and so does any other
    type (`True` and `False` aren't numbers here); any other amount that can't be written raises
    `ValueError`.
