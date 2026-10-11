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

    def test_prefixes(self):
        self.check([
            (5, 'km', 'm', 5000.0),
            (3, 'mm', 'nm', 3000000.0),
            (5, 'µs', 'ns', 4999.999999999999),
            (5, 'us', 'ms', 0.004999999999999999),
            (1, 'Gg', 't', 1000.0),
            (1, 'mol', 'mmol', 1000.0),
            (1, 'cd', 'mcd', 1000.0),
            (2, 'MW', 'kW', 2000.0),
            (40, 'cL', 'mL', 400.00000000000006),
        ])

    def test_derived_units(self):
        self.check([
            (1, 'N', 'kg*m/s^2', 1.0),
            (1, 'kg*m/s^2', 'g*cm*s^-2', 100000.0),
            (1, 'kW*h', 'MJ', 3.6),
            (101325, 'Pa', 'kPa', 101.325),
            (1, 'kPa', 'N/cm^2', 0.1),
            (1, 'C', 'A*s', 1.0),
            (1, 'V', 'W/A', 1.0),
            (1, 'W', 'J/s', 1.0),
            (1, 'J', 'W*h', 0.0002777777777777778),
        ])

    def test_time_and_volume(self):
        self.check([
            (1, 'h', 'min', 60.0),
            (2, 'd', 'h', 48.0),
            (1, 'ks', 'min', 16.666666666666668),
            (90, 'km/h', 'm/s', 25.0),
            (72, 'km/h', 'm/min', 1200.0),
            (1, 'L', 'm^3', 0.001),
            (250, 'mL', 'cm^3', 249.99999999999997),
            (1, 't', 'kg', 1000.0),
        ])

    def test_temperature_scales(self):
        self.check([
            (100, 'degC', 'degF', 211.99999999999997),
            (0, 'degC', 'K', 273.15),
            (32, 'degF', 'degC', 0.0),
            (-40, 'degC', 'degF', -40.00000000000001),
            (98.6, 'degF', 'degC', 37.0),
            (1, 'K', 'degC', -272.15),
            (0, 'K', 'degF', -459.66999999999996),
            (20, 'degC', 'degC', 20.0),
            (300, 'K', 'K', 300.0),
        ])

    def test_dimensionless_units(self):
        self.check([
            (50, '%', '1', 0.5),
            (1, 'rad', 'deg', 57.29577951308232),
            (90, 'deg', 'rad', 1.5707963267948966),
            (3, 'ppm', '%', 0.00030000000000000003),
            (1, 'rad/s', 'Hz', 1.0),
            (5, 'mrad', 'rad', 0.005),
            (25, '%', 'ppm', 250000.0),
            (2, 'deg/s', 'rad*Hz', 0.03490658503988659),
        ])

    def test_powers_and_order(self):
        self.check([
            (1, 'm^2', 'cm^2', 10000.0),
            (1, 's^-1', 'Hz', 1.0),
            (1, 'Hz', '1/s', 1.0),
            (60, '1/min', 'Hz', 1.0),
            (9.81, 'm/s/s', 'm*s^-2', 9.81),
            (1, 'J/mol/K', 'J*mol^-1*K^-1', 1.0),
            (1, 'J/mol*K', 'J*K/mol', 1.0),
            (2, 'm·s', 's * m', 2.0),
            (3, 'm^3', 'L', 3000.0),
            (-40, 'K', 'K', -40.0),
            (0.5, 'km^2', 'm^2', 500000.0),
        ])

    def test_what_cant_be_converted(self):
        for source, target in [('m', 's'), ('N', 'J'), ('km/h', 'm'), ('cm^3', 'L^2'), ('J/mol/K', 'J*K/mol'), ('furlong', 'm'), ('kh', 's'), ('dm', 'm'), ('mmin', 's'), ('kt', 'g'), ('Km', 'm'), ('degC*m', 'K*m'), ('degC', 'm'), ('kdegC', 'K'), ('degC^2', 'K^2'), ('mK', 'degC'), ('degC', 'K*s/s'), ('mdeg', 'rad'), ('m%', '1'), ('%', 'm'), ('deg', 's'), ('degF', '1'), ('m//s', 'm'), ('m*', 'm'), ('*m', 'm'), ('m^', 'm'), ('m^1.5', 'm'), ('m^x', 'm'), ('', 'm'), ('m s', 'm'), ('k g', 'g'), ('m/', 'm'), ('M', 'm')]:
            with self.subTest(source=source, target=target):
                with self.assertRaises(ValueError):
                    convert(1, source, target)


if __name__ == "__main__":
    unittest.main()
