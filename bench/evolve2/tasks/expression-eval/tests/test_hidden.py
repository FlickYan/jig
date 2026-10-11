import unittest

from calc import EvalError, evaluate

VARIABLES = {'x': 3, 'y': 0.5, 'rate_2': 4}


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

    def test_precedence_and_associativity(self):
        self.values([
            ('1 + 2 * 3', 7, 'int'),
            ('(1 + 2) * 3', 9, 'int'),
            ('10 - 4 - 3', 3, 'int'),
            ('2 * 3 % 4', 2, 'int'),
            ('8 % 3 ** 2', 8, 'int'),
            ('2 ** 3 ** 2', 512, 'int'),
            ('(((1)))', 1, 'int'),
        ])

    def test_unary_minus_and_power(self):
        self.values([
            ('-2 ** 2', -4, 'int'),
            ('2 ** -1', 0.5, 'float'),
            ('-2 ** -2', -0.25, 'float'),
            ('(-2) ** 2', 4, 'int'),
            ('--3', 3, 'int'),
            ('-+-3', 3, 'int'),
            ('-x ** 2', -9, 'int'),
        ])

    def test_python_arithmetic(self):
        self.values([
            ('7 / 2', 3.5, 'float'),
            ('6 / 2', 3.0, 'float'),
            ('7 // 2', 3, 'int'),
            ('-7 // 2', -4, 'int'),
            ('7 % -3', -2, 'int'),
            ('-7 % 3', 2, 'int'),
            ('7.5 // 2', 3.0, 'float'),
            ('0 ** 0', 1, 'int'),
            ('2 ** 100', 1267650600228229401496703205376, 'int'),
            ('1.5 + 1', 2.5, 'float'),
        ])

    def test_numbers_and_spaces(self):
        self.values([
            ('1e3', 1000.0, 'float'),
            ('2.5e-1 * 4', 1.0, 'float'),
            ('2.5E+1', 25.0, 'float'),
            ('  1\t+ 2 ', 3, 'int'),
            ('007 + 1', 8, 'int'),
            ('3.0', 3.0, 'float'),
        ])

    def test_comparisons_chain(self):
        self.values([
            ('1 < x < 5', True, 'bool'),
            ('1 < 2 == True', False, 'bool'),
            ('(1 < 2) == True', True, 'bool'),
            ('x >= 3 > y != 0.5', False, 'bool'),
            ('2 == 2.0', True, 'bool'),
            ('1 < 2 > 1 < 0', False, 'bool'),
            ('not 1 == 2', True, 'bool'),
            ('x != x', False, 'bool'),
        ])

    def test_and_or_give_an_operand(self):
        self.values([
            ('0 or 5', 5, 'int'),
            ('2 and 0', 0, 'int'),
            ('0 or False', False, 'bool'),
            ('x > 2 and y', 0.5, 'float'),
            ('not 0 and 5', 5, 'int'),
            ('1 and 2 and 3', 3, 'int'),
            ('0 and 1 / 0', 0, 'int'),
            ('1 or z', 1, 'int'),
            ('False and z', False, 'bool'),
            ('3 < 2 < z', False, 'bool'),
            ('not (x and 0)', True, 'bool'),
        ])

    def test_conditionals(self):
        self.values([
            ('1 if x > 2 else 0', 1, 'int'),
            ('1 if 0 else 2 if 0 else 3', 3, 'int'),
            ('z if False else 2', 2, 'int'),
            ('1 / 0 if False else 7', 7, 'int'),
            ('(1 if True else 2) + 3', 4, 'int'),
            ('max(1 if x > 2 else 9, 4)', 4, 'int'),
            ('x if x else -x', 3, 'int'),
        ])

    def test_booleans_in_arithmetic(self):
        self.values([
            ('True + True', 2, 'int'),
            ('-True', -1, 'int'),
            ('True * 2.5', 2.5, 'float'),
            ('abs(False)', 0, 'int'),
            ('True / 2', 0.5, 'float'),
            ('max(True, 0)', True, 'bool'),
        ])

    def test_variables_and_functions(self):
        self.values([
            ('x * y', 1.5, 'float'),
            ('x ** 2 - y', 8.5, 'float'),
            ('rate_2 / x', 1.3333333333333333, 'float'),
            ('abs(-3) + abs(2.5)', 5.5, 'float'),
            ('min(3, 1, 2)', 1, 'int'),
            ('max(1, 2.5)', 2.5, 'float'),
            ('max(-1, min(4, 5))', 4, 'int'),
            ('round(2.5)', 2, 'int'),
            ('round(3.5)', 4, 'int'),
            ('round(2.567, 2)', 2.57, 'float'),
            ('round(7)', 7, 'int'),
            ('round(-x / 2)', -2, 'int'),
            ('max(5)', 5, 'int'),
            ('min(2.5)', 2.5, 'float'),
        ])

    def test_unexpected_characters(self):
        self.errors([
            ('1 & 2', "unexpected character '&' at 2"),
            ('5.', "unexpected character '.' at 1"),
            ('.5', "unexpected character '.' at 0"),
            ('2 # 3', "unexpected character '#' at 2"),
        ])

    def test_syntax_errors(self):
        self.errors([
            ('1 +', 'unexpected end'),
            ('', 'unexpected end'),
            ('   ', 'unexpected end'),
            ('(1', 'unexpected end'),
            ('1 + * 2', "unexpected '*' at 4"),
            ('1 2', "unexpected '2' at 2"),
            (')', "unexpected ')' at 0"),
            ('(1))', "unexpected ')' at 3"),
            ('max(1,)', "unexpected ')' at 6"),
            ('1 + 2 )', "unexpected ')' at 6"),
            ('x y', "unexpected 'y' at 2"),
            ('(', 'unexpected end'),
            ('2 ** ', 'unexpected end'),
            ('f(1 2)', "unexpected '2' at 4"),
        ])

    def test_syntax_before_evaluation(self):
        self.errors([
            ('1 / 0 + )', "unexpected ')' at 8"),
            ('z + (', 'unexpected end'),
            ('max() 1', "unexpected '1' at 6"),
            ('0 and 1 / 0 +', 'unexpected end'),
        ])

    def test_keywords_and_comparisons_in_the_wrong_place(self):
        self.errors([
            ('1 <', 'unexpected end'),
            ('1 < < 2', "unexpected '<' at 4"),
            ('not', 'unexpected end'),
            ('not not', 'unexpected end'),
            ('1 if 2', 'unexpected end'),
            ('1 if 2 else', 'unexpected end'),
            ('x and', 'unexpected end'),
            ('and', "unexpected 'and' at 0"),
            ('1 == == 2', "unexpected '==' at 5"),
            ('1 = 2', "unexpected character '=' at 2"),
            ('1 ! 2', "unexpected character '!' at 2"),
            ('True(1)', "unexpected '(' at 4"),
            ('if', "unexpected 'if' at 0"),
            ('1 + not 2', "unexpected 'not' at 4"),
            ('x or or 1', "unexpected 'or' at 5"),
        ])

    def test_short_circuits_still_evaluate_what_they_reach(self):
        self.errors([
            ('1 < 2 < z', "unknown name 'z'"),
            ('True and z', "unknown name 'z'"),
            ('z if True else 0', "unknown name 'z'"),
            ('(1 / 0) if z else 2', "unknown name 'z'"),
            ('0 or 1 / 0', 'division by zero'),
            ('not z', "unknown name 'z'"),
        ])

    def test_evaluation_errors(self):
        self.errors([
            ('max()', 'wrong number of arguments to max'),
            ('abs(1, 2)', 'wrong number of arguments to abs'),
            ('round(1, 2, 3)', 'wrong number of arguments to round'),
            ('f(1)', "unknown function 'f'"),
            ('f(z)', "unknown function 'f'"),
            ('abs(z, 1)', 'wrong number of arguments to abs'),
            ('abs', "unknown name 'abs'"),
            ('z + 1', "unknown name 'z'"),
            ('1 / 0', 'division by zero'),
            ('5 % 0', 'division by zero'),
            ('5 // 0.0', 'division by zero'),
            ('0 ** -1', 'division by zero'),
            ('(-8) ** 0.5', 'not a real number'),
            ('x + 1 / 0', 'division by zero'),
            ('1 / 0 + z', 'division by zero'),
            ('2 ** (1 / 0)', 'division by zero'),
            ('max(1, z)', "unknown name 'z'"),
            ('min(z, 1 / 0)', "unknown name 'z'"),
        ])

    def test_no_variables(self):
        self.assertEqual(evaluate("1 + 1"), 2)
        with self.assertRaises(EvalError):
            evaluate("x")

    def test_eval_error_is_a_value_error(self):
        self.assertTrue(issubclass(EvalError, ValueError))


if __name__ == "__main__":
    unittest.main()
