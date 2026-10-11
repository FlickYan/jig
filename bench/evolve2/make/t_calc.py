import importlib.util
from maketask import task

spec = importlib.util.spec_from_file_location("c", "calc_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
VARIABLES = {"x": 3, "y": 0.5, "rate_2": 4}
VALUES = {
    "test_precedence_and_associativity": ["1 + 2 * 3", "(1 + 2) * 3", "10 - 4 - 3", "2 * 3 % 4", "8 % 3 ** 2", "2 ** 3 ** 2", "(((1)))"],
    "test_unary_minus_and_power": ["-2 ** 2", "2 ** -1", "-2 ** -2", "(-2) ** 2", "--3", "-+-3", "-x ** 2"],
    "test_python_arithmetic": ["7 / 2", "6 / 2", "7 // 2", "-7 // 2", "7 % -3", "-7 % 3", "7.5 // 2", "0 ** 0", "2 ** 100", "1.5 + 1"],
    "test_numbers_and_spaces": ["1e3", "2.5e-1 * 4", "2.5E+1", "  1\t+ 2 ", "007 + 1", "3.0"],
    "test_comparisons_chain": ["1 < x < 5", "1 < 2 == True", "(1 < 2) == True", "x >= 3 > y != 0.5", "2 == 2.0", "1 < 2 > 1 < 0", "not 1 == 2", "x != x"],
    "test_and_or_give_an_operand": ["0 or 5", "2 and 0", "0 or False", "x > 2 and y", "not 0 and 5", "1 and 2 and 3", "0 and 1 / 0", "1 or z", "False and z", "3 < 2 < z", "not (x and 0)"],
    "test_conditionals": ["1 if x > 2 else 0", "1 if 0 else 2 if 0 else 3", "z if False else 2", "1 / 0 if False else 7", "(1 if True else 2) + 3", "max(1 if x > 2 else 9, 4)", "x if x else -x"],
    "test_booleans_in_arithmetic": ["True + True", "-True", "True * 2.5", "abs(False)", "True / 2", "max(True, 0)"],
    "test_variables_and_functions": ["x * y", "x ** 2 - y", "rate_2 / x", "abs(-3) + abs(2.5)", "min(3, 1, 2)", "max(1, 2.5)", "max(-1, min(4, 5))", "round(2.5)", "round(3.5)", "round(2.567, 2)", "round(7)", "round(-x / 2)", "max(5)", "min(2.5)"],
}
ERRORS = {
    "test_unexpected_characters": ["1 & 2", "5.", ".5", "2 # 3"],
    "test_syntax_errors": ["1 +", "", "   ", "(1", "1 + * 2", "1 2", ")", "(1))", "max(1,)", "1 + 2 )", "x y", "(", "2 ** ", "f(1 2)"],
    "test_syntax_before_evaluation": ["1 / 0 + )", "z + (", "max() 1", "0 and 1 / 0 +"],
    "test_keywords_and_comparisons_in_the_wrong_place": ["1 <", "1 < < 2", "not", "not not", "1 if 2", "1 if 2 else", "x and", "and", "1 == == 2", "1 = 2", "1 ! 2", "True(1)", "if", "1 + not 2", "x or or 1"],
    "test_short_circuits_still_evaluate_what_they_reach": ["1 < 2 < z", "True and z", "z if True else 0", "(1 / 0) if z else 2", "0 or 1 / 0", "not z"],
    "test_evaluation_errors": ["max()", "abs(1, 2)", "round(1, 2, 3)", "f(1)", "f(z)", "abs(z, 1)", "abs", "z + 1", "1 / 0", "5 % 0", "5 // 0.0", "0 ** -1", "(-8) ** 0.5",
                               "x + 1 / 0", "1 / 0 + z", "2 ** (1 / 0)", "max(1, z)", "min(z, 1 / 0)"],
}

def run(text):
    try:
        return ("value", m.evaluate(text, VARIABLES))
    except m.EvalError as error:
        return ("error", str(error))

methods = []
for method, texts in VALUES.items():
    rows = []
    for text in texts:
        kind, value = run(text)
        assert kind == "value", (text, value)
        rows.append(f"            ({text!r}, {value!r}, {type(value).__name__!r}),")
    methods.append(f"    def {method}(self):\n        self.values([\n" + "\n".join(rows) + "\n        ])\n")
for method, texts in ERRORS.items():
    rows = []
    for text in texts:
        kind, message = run(text)
        assert kind == "error", (text, message)
        rows.append(f"            ({text!r}, {message!r}),")
    methods.append(f"    def {method}(self):\n        self.errors([\n" + "\n".join(rows) + "\n        ])\n")

hidden = f'''
import unittest

from calc import EvalError, evaluate

VARIABLES = {VARIABLES!r}


class TestSpec(unittest.TestCase):
    def values(self, cases):
        for expression, expected, kind in cases:
            with self.subTest(expression=expression):
                result = evaluate(expression, VARIABLES)
                self.assertEqual(type(result).__name__, kind)
                self.assertEqual(result, expected)

    def errors(self, cases):
        for expression, message in cases:
            with self.subTest(expression=expression):
                with self.assertRaises(EvalError) as caught:
                    evaluate(expression, VARIABLES)
                self.assertEqual(str(caught.exception), message)

''' + "\n".join(methods) + '''
    def test_no_variables(self):
        self.assertEqual(evaluate("1 + 1"), 2)
        with self.assertRaises(EvalError):
            evaluate("x")

    def test_eval_error_is_a_value_error(self):
        self.assertTrue(issubclass(EvalError, ValueError))


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
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
'''

task(
    "expression-eval",
    "Implement evaluate in calc.py so that it follows SPEC.md exactly.",
    ["python", "spec", "parsing"],
    {
        "SPEC.md": SPEC,
        "calc.py": '''
            class EvalError(ValueError):
                """The expression can't be evaluated."""


            def evaluate(expression, variables=None):
                """The value of an arithmetic expression. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_calc.py": '''
            import unittest

            from calc import EvalError, evaluate


            class TestBasics(unittest.TestCase):
                def test_arithmetic(self):
                    self.assertEqual(evaluate("1 + 2 * 3"), 7)
                    self.assertEqual(evaluate("x / 2", {"x": 5}), 2.5)

                def test_logic(self):
                    self.assertIs(evaluate("1 < x and x < 5", {"x": 2}), True)

                def test_error(self):
                    with self.assertRaises(EvalError):
                        evaluate("1 +")


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"calc.py": open("calc_solution.py").read()},
)
