"""Converting quantities between units. See SPEC.md."""
import math
import re

# Each unit: its size in base units (m, g, s, A, K, mol, cd) and its dimension, as powers of them.
UNITS = {
    "m": (1, {"m": 1}), "g": (1, {"g": 1}), "s": (1, {"s": 1}), "A": (1, {"A": 1}), "K": (1, {"K": 1}),
    "mol": (1, {"mol": 1}), "cd": (1, {"cd": 1}),
    "N": (1000, {"g": 1, "m": 1, "s": -2}), "J": (1000, {"g": 1, "m": 2, "s": -2}), "W": (1000, {"g": 1, "m": 2, "s": -3}),
    "Pa": (1000, {"g": 1, "m": -1, "s": -2}), "Hz": (1, {"s": -1}), "C": (1, {"A": 1, "s": 1}),
    "V": (1000, {"g": 1, "m": 2, "s": -3, "A": -1}), "L": (0.001, {"m": 3}),
    "min": (60, {"s": 1}), "h": (3600, {"s": 1}), "d": (86400, {"s": 1}), "t": (1_000_000, {"g": 1}),
    "rad": (1, {}), "deg": (math.pi / 180, {}), "%": (0.01, {}), "ppm": (1e-6, {}),
}
PREFIXABLE = {"m", "g", "s", "A", "K", "mol", "cd", "N", "J", "W", "Pa", "Hz", "C", "V", "L", "rad"}
# Temperature scales: kelvin = value * factor + offset.
SCALES = {"K": (1, 0), "degC": (1, 273.15), "degF": (5 / 9, 273.15 - 32 * 5 / 9)}
PREFIXES = {"G": 1e9, "M": 1e6, "k": 1e3, "c": 1e-2, "m": 1e-3, "u": 1e-6, "µ": 1e-6, "μ": 1e-6, "n": 1e-9}
FACTOR = re.compile(r"(1|[A-Za-zµμ]+|%)(?:\^(-?\d+))?")


def _unit(symbol):
    if symbol in UNITS:
        return UNITS[symbol]
    if symbol[0] in PREFIXES and symbol[1:] in PREFIXABLE:
        scale, dimension = UNITS[symbol[1:]]
        return PREFIXES[symbol[0]] * scale, dimension
    raise ValueError(f"unknown unit {symbol!r}")


def parse(text):
    """A unit expression's size in base units, and its dimension."""
    if not isinstance(text, str):
        raise ValueError(f"not a unit: {text!r}")
    scale, dimension = 1.0, {}
    position, operator = 0, "*"
    while True:
        match = FACTOR.match(text, position)
        if not match:
            raise ValueError(f"not a unit: {text!r}")
        size, powers = (1, {}) if match.group(1) == "1" else _unit(match.group(1))
        exponent = int(match.group(2) or 1) * (1 if operator == "*" else -1)
        scale *= size ** exponent
        for base, power in powers.items():
            dimension[base] = dimension.get(base, 0) + power * exponent
        position = match.end()
        if position == len(text):
            return scale, {base: power for base, power in dimension.items() if power}
        separator = re.compile(r" *([*·/]) *").match(text, position)
        if not separator:
            raise ValueError(f"not a unit: {text!r}")
        operator = "/" if separator.group(1) == "/" else "*"
        position = separator.end()


def convert(value, source, target):
    if source in ("degC", "degF") or target in ("degC", "degF"):
        if source not in SCALES or target not in SCALES:
            raise ValueError(f"a temperature scale converts only to another one, or to K: {source} and {target}")
        (source_factor, source_offset), (target_factor, target_offset) = SCALES[source], SCALES[target]
        return float((value * source_factor + source_offset - target_offset) / target_factor)
    source_scale, source_dimension = parse(source)
    target_scale, target_dimension = parse(target)
    if source_dimension != target_dimension:
        raise ValueError(f"incompatible units: {source} and {target}")
    return value * source_scale / target_scale
