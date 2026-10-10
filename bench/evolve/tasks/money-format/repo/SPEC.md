# format_money(amount, currency, locale="en", accounting=False) -> str

Formats an amount of money given as an integer number of the currency's minor units (cents for USD).

1. Currencies and their decimal places: USD, EUR, GBP 2; JPY and KRW 0; BHD and KWD 3. So
   `format_money(123456, "USD")` is `$1,234.56`, while `format_money(1234, "JPY")` is `¥1,234`.
2. Symbols: USD `$`, EUR `€`, GBP `£`, JPY `¥`, KRW `₩`. BHD and KWD have no symbol: their code
   is used, followed by a space in `en` and preceded by a no-break space elsewhere.
3. Locales:
   - `en`: the symbol before the number, `,` between thousands, `.` before the decimals:
     `$1,234.56`, `BHD 1,234.567`.
   - `de`: the number first, then a no-break space (U+00A0) and the symbol; `.` between thousands and
     `,` before the decimals: `1.234,56 €` (with U+00A0 before €).
   - `fr`: like `de`, but thousands are separated by a narrow no-break space (U+202F): `1 234,56 €`
     (U+202F in the number, U+00A0 before €).
4. Thousands are grouped in threes from the right, for every number of digits: `$1,234,567.89`.
   A number under 1000 has no separator: `$999.00`.
5. Negative amounts: in `en` a minus sign before the symbol (`-$5.00`); in `de` and `fr` before the
   number (`-5,00 €`). With `accounting=True`, no minus sign: the whole result goes in parentheses
   instead (`($5.00)`, `(5,00 €)`).
6. Zero is never negative: `-0` formats as `$0.00`.
7. An unknown currency or locale, or an amount that isn't an integer (floats and booleans included),
   raises `ValueError`.
