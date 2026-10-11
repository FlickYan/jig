# convert(value, source, target) -> float

Converts a quantity from one unit to another: `convert(90, "km/h", "m/s")` is `25.0`. A unit that isn't
valid, or two units that don't measure the same thing, raise `ValueError`.

## Units

1. The base units are `m` (metre), `g` (gram), `s` (second), `A` (ampere), `K` (kelvin), `mol` (mole) and
   `cd` (candela).
2. The other units: `N` (newton) is kg·m/s², `J` (joule) N·m, `W` (watt) J/s, `Pa` (pascal) N/m², `Hz`
   (hertz) 1/s, `C` (coulomb) A·s, `V` (volt) W/A, `L` (litre) 0.001 m³, `min` 60 s, `h` 3600 s, `d`
   86400 s, and `t` (tonne) 1000 kg.
3. Prefixes: `G` (10⁹), `M` (10⁶), `k` (10³), `c` (10⁻²), `m` (10⁻³), `µ` or `u` (10⁻⁶) and `n` (10⁻⁹).
   A prefix may come before every unit except `min`, `h`, `d` and `t`: `km` is a kilometre, `ms` a
   millisecond, `kg` a kilogram, but `kh` isn't a unit. A symbol that is a unit itself is that unit, and
   only otherwise a prefix and a unit: `m` is a metre, `mm` a millimetre, `min` a minute, `cd` a candela.
   A prefix belongs to its unit before any power: `cm^3` is a cubic centimetre, (cm)³.

## Expressions

4. A unit expression is units joined by `*` or `·` (multiplied) and `/` (divided), with optional spaces
   around those signs and nowhere else. Each unit may have a power, `^` and an integer that may be
   negative: `m^2`, `s^-2`. `1` stands for no unit, as in `1/s`.
5. `*` and `/` apply from left to right to the unit just after them, as in arithmetic: `m/s/s` is m/s²,
   and `J/mol*K` is J·K/mol, not J/(mol·K).

## Converting

6. Two expressions measure the same thing if they come to the same powers of the base units; then the
   result is `value` times the size of `source`, divided by the size of `target`, as a float. Otherwise
   `ValueError` is raised.
7. Four units measure nothing, like `1`: `rad` (the radian, which is 1, and takes prefixes: `mrad`),
   `deg` (π/180), `%` (0.01) and `ppm` (10⁻⁶). None but `rad` takes a prefix.
8. Two temperature scales, `degC` (Celsius) and `degF` (Fahrenheit), are converted with their offsets:
   a temperature in kelvins is degC + 273.15, and degF is 32 + 9/5 × degC. They can be converted only to
   and from each other and `K`, with each expression just that one symbol: no prefix, power or other unit
   with them (`degC*m`, `kdegC` and `mK` to `degC` all raise `ValueError`). In any other expression, `K`
   is an ordinary unit.
