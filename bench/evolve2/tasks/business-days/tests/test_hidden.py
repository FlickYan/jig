import unittest
from datetime import date, timedelta

from workdays import add_business_days, business_days_between, holidays_in

d = date.fromisoformat


class TestSpec(unittest.TestCase):
    def test_holidays_in_a_year(self):
        for year, rules, expected in [(2021, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], ['2021-01-01', '2021-01-18', '2021-05-31', '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24', '2021-12-31']), (2022, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], ['2022-01-17', '2022-05-30', '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26']), (2023, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], ['2023-01-02', '2023-01-16', '2023-05-29', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25']), (2027, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], ['2027-01-01', '2027-01-18', '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24', '2027-12-31']), (2021, ['12-24', '12-25'], ['2021-12-24']), (2022, ['12-24', '12-25'], ['2022-12-23', '2022-12-26']), (2008, ['5th Friday of February'], ['2008-02-29']), (2024, ['5th Friday of February'], []), (2024, ['02-29'], ['2024-02-29']), (2023, ['02-29'], []), (2032, ['02-29'], ['2032-03-01']), (2024, [], []), (2024, ['last Sunday of March', '1st Saturday of June'], ['2024-03-31', '2024-06-01'])]:
            with self.subTest(year=year, rules=rules):
                self.assertEqual([day.isoformat() for day in holidays_in(year, rules)], expected)

    def test_adding_business_days(self):
        for start, n, rules, expected in [('2021-12-23', 1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-27'), ('2021-12-23', 2, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-28'), ('2021-12-23', 4, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-30'), ('2021-12-23', 5, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2022-01-03'), ('2021-12-23', 0, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-23'), ('2021-12-23', -1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-22'), ('2021-12-23', -3, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-20'), ('2022-01-03', -1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-30'), ('2021-12-25', 0, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-27'), ('2021-12-25', 1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-27'), ('2021-12-25', -1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-23'), ('2021-11-24', 1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-11-26'), ('2021-12-31', 254, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2022-12-30'), ('2022-12-30', -254, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2021-12-30'), ('2024-01-05', 1, [], '2024-01-08'), ('2024-01-06', 0, [], '2024-01-08'), ('2023-12-29', 1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2024-01-02'), ('2027-12-30', 1, ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], '2028-01-03')]:
            with self.subTest(start=start, n=n, rules=rules):
                self.assertEqual(add_business_days(d(start), n, rules), d(expected))

    def test_counting_business_days(self):
        for start, end, rules, expected in [('2021-12-23', '2022-01-03', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 5), ('2022-01-03', '2021-12-23', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], -5), ('2021-12-23', '2021-12-23', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 0), ('2021-12-31', '2022-12-31', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 254), ('2021-12-25', '2021-12-27', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 1), ('2024-01-01', '2024-01-08', [], 5), ('2021-12-24', '2021-12-31', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 4), ('2027-12-23', '2028-01-04', ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25'], 6)]:
            with self.subTest(start=start, end=end, rules=rules):
                self.assertEqual(business_days_between(d(start), d(end), rules), expected)

    def test_adding_what_was_counted(self):
        rules = ['01-01', '3rd Monday of January', 'last Monday of May', '07-04', '1st Monday of September', '4th Thursday of November', '12-25']
        start = date(2021, 11, 20)
        for days in range(0, 80, 3):
            end = start + timedelta(days=days)
            if end.weekday() < 5 and end not in holidays_in(end.year, rules):
                with self.subTest(end=end):
                    self.assertEqual(add_business_days(start, business_days_between(start, end, rules), rules), end)

    def test_invalid_rules(self):
        for rule in ['13-01', '02-30', '00-10', '1st Funday of May', '6th Monday of May', 'first Monday of May', '3rd monday of january', '1-1', '12/25', 1225, 'last Monday of Mayday']:
            with self.subTest(rule=rule):
                with self.assertRaises(ValueError):
                    holidays_in(2024, [rule])
                with self.assertRaises(ValueError):
                    add_business_days(date(2024, 1, 2), 1, [rule])


if __name__ == "__main__":
    unittest.main()
