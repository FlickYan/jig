import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("u", "units_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
GROUPS = {
    "test_prefixes": [(5, "km", "m"), (3, "mm", "nm"), (5, "µs", "ns"), (5, "us", "ms"), (1, "Gg", "t"), (1, "mol", "mmol"), (1, "cd", "mcd"), (2, "MW", "kW"), (40, "cL", "mL")],
    "test_derived_units": [(1, "N", "kg*m/s^2"), (1, "kg*m/s^2", "g*cm*s^-2"), (1, "kW*h", "MJ"), (101325, "Pa", "kPa"), (1, "kPa", "N/cm^2"), (1, "C", "A*s"), (1, "V", "W/A"), (1, "W", "J/s"), (1, "J", "W*h")],
    "test_time_and_volume": [(1, "h", "min"), (2, "d", "h"), (1, "ks", "min"), (90, "km/h", "m/s"), (72, "km/h", "m/min"), (1, "L", "m^3"), (250, "mL", "cm^3"), (1, "t", "kg")],
    "test_temperature_scales": [(100, "degC", "degF"), (0, "degC", "K"), (32, "degF", "degC"), (-40, "degC", "degF"), (98.6, "degF", "degC"), (1, "K", "degC"), (0, "K", "degF"), (20, "degC", "degC"), (300, "K", "K")],
    "test_dimensionless_units": [(50, "%", "1"), (1, "rad", "deg"), (90, "deg", "rad"), (3, "ppm", "%"), (1, "rad/s", "Hz"), (5, "mrad", "rad"), (25, "%", "ppm"), (2, "deg/s", "rad*Hz")],
    "test_powers_and_order": [(1, "m^2", "cm^2"), (1, "s^-1", "Hz"), (1, "Hz", "1/s"), (60, "1/min", "Hz"), (9.81, "m/s/s", "m*s^-2"), (1, "J/mol/K", "J*mol^-1*K^-1"), (1, "J/mol*K", "J*K/mol"), (2, "m·s", "s * m"), (3, "m^3", "L"), (-40, "K", "K"), (0.5, "km^2", "m^2")],
}
INVALID = [("m", "s"), ("N", "J"), ("km/h", "m"), ("cm^3", "L^2"), ("J/mol/K", "J*K/mol"), ("furlong", "m"), ("kh", "s"), ("dm", "m"), ("mmin", "s"), ("kt", "g"), ("Km", "m"),
           ("degC*m", "K*m"), ("degC", "m"), ("kdegC", "K"), ("degC^2", "K^2"), ("mK", "degC"), ("degC", "K*s/s"), ("mdeg", "rad"), ("m%", "1"), ("%", "m"), ("deg", "s"), ("degF", "1"),
           ("m//s", "m"), ("m*", "m"), ("*m", "m"), ("m^", "m"), ("m^1.5", "m"), ("m^x", "m"), ("", "m"), ("m s", "m"), ("k g", "g"), ("m/", "m"), ("M", "m")]
for a, b in INVALID:
    try:
        m.convert(1, a, b); raise SystemExit(f"accepted {a} {b}")
    except ValueError:
        pass

methods = []
for method, cases in GROUPS.items():
    body = "\n".join(f"            ({v!r}, {a!r}, {b!r}, {m.convert(v, a, b)!r})," for v, a, b in cases)
    methods.append(f"    def {method}(self):\n        self.check([\n{body}\n        ])\n")

hidden = '''
import math
import unittest

from units import convert


class TestSpec(unittest.TestCase):
    def check(self, cases):
        for value, source, target, expected in cases:
            with self.subTest(value=value, source=source, target=target):
                result = convert(value, source, target)
                self.assertIsInstance(result, float)
                self.assertTrue(math.isclose(result, expected, rel_tol=1e-9, abs_tol=1e-9), f"{result} != {expected}")

''' + "\n".join(methods) + f'''
    def test_what_cant_be_converted(self):
        for source, target in {INVALID!r}:
            with self.subTest(source=source, target=target):
                with self.assertRaises(ValueError):
                    convert(1, source, target)


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
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
'''

task(
    "unit-convert",
    "Implement convert in units.py so that it follows SPEC.md exactly.",
    ["python", "spec", "parsing"],
    {
        "SPEC.md": SPEC,
        "units.py": '''
            def convert(value, source, target):
                """value in the unit source, converted to the unit target. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_units.py": '''
            import math
            import unittest

            from units import convert


            class TestBasics(unittest.TestCase):
                def test_speed(self):
                    self.assertTrue(math.isclose(convert(90, "km/h", "m/s"), 25.0))

                def test_incompatible(self):
                    with self.assertRaises(ValueError):
                        convert(1, "m", "s")


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"units.py": open("units_solution.py").read()},
)
