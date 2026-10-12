"""vendored-retry: retrying "the way the rest of the project retries" means finding that way.

What the agent must find: the project vendors its own retry helper (vendor/retrying_lite), which other
calls already use with the configured number of attempts (settings.RETRIES), the project's backoff
(clock.sleep with doubling delays from settings.BACKOFF), and give_up= to raise the project's own error.
A hand-written loop around time.sleep, a pip package (none is installed), or retrying on every
exception fails the hidden tests.
"""
from maketask import task

FILES = {
    "README.md": """
        # reports

        Fetches the shop's sales reports from the reporting service.
        """,
    "vendor/__init__.py": "",
    "vendor/retrying_lite/__init__.py": '''
        """A small retry decorator, vendored from an internal library (version 0.3).

            @retrying(on=(TimeoutError,), attempts=3, delays=backoff(0.5), sleep=time.sleep, give_up=None)

        on       exception types that are retried; anything else goes straight through
        attempts how many calls in all, the first included
        delays   an iterable of seconds to wait before each retry
        sleep    the function that waits (tests pass a fake)
        give_up  called with the last exception once the attempts are used up; what it returns is raised
        """
        import functools
        import itertools
        import time


        def backoff(first, factor=2):
            """first, first*factor, first*factor**2, ..."""
            return (first * factor**n for n in itertools.count())


        def retrying(on, attempts, delays, sleep=time.sleep, give_up=None):
            def decorate(function):
                @functools.wraps(function)
                def wrapper(*args, **kwargs):
                    waits = iter(delays() if callable(delays) else delays)
                    for attempt in range(1, attempts + 1):
                        try:
                            return function(*args, **kwargs)
                        except on as err:
                            if attempt == attempts:
                                if give_up is None:
                                    raise
                                raise give_up(err) from err
                            sleep(next(waits))
                return wrapper
            return decorate
        ''',
    "reports/__init__.py": "",
    "reports/settings.py": """
        RETRIES = 4  # calls in all, the first included
        BACKOFF = 0.25  # seconds before the first retry; it doubles each time
        """,
    "reports/clock.py": """
        import time


        def sleep(seconds):
            \"\"\"Every wait in the package goes through here, so tests can make it instant.\"\"\"
            time.sleep(seconds)
        """,
    "reports/errors.py": """
        class ServiceUnavailable(Exception):
            \"\"\"The reporting service didn't answer, even after retrying.\"\"\"
        """,
    "reports/transport.py": """
        class Transport:
            \"\"\"Talks to the reporting service. Tests replace it with a fake.\"\"\"

            def get(self, path):
                raise NotImplementedError("no network in this sandbox")
        """,
    "reports/customers.py": """
        from reports import clock, settings
        from reports.errors import ServiceUnavailable
        from vendor.retrying_lite import backoff, retrying


        @retrying(on=(TimeoutError,), attempts=settings.RETRIES, delays=lambda: backoff(settings.BACKOFF),
                  sleep=lambda seconds: clock.sleep(seconds), give_up=lambda err: ServiceUnavailable(f"customers: {err}"))
        def fetch_customers(transport):
            return transport.get("/customers")
        """,
    "reports/sales.py": """
        def fetch_report(transport, month):
            \"\"\"The sales report for a month (YYYY-MM).\"\"\"
            return transport.get(f"/reports/sales/{month}")
        """,
    "tests/__init__.py": "",
    "tests/test_sales.py": """
        import unittest

        from reports.sales import fetch_report


        class Answering:
            def get(self, path):
                return {"path": path}


        class SalesTest(unittest.TestCase):
            def test_fetches_the_month(self):
                self.assertEqual(fetch_report(Answering(), "2026-01"), {"path": "/reports/sales/2026-01"})
        """,
}

SOLUTION = {
    "reports/sales.py": """
        from reports import clock, settings
        from reports.errors import ServiceUnavailable
        from vendor.retrying_lite import backoff, retrying


        @retrying(on=(TimeoutError,), attempts=settings.RETRIES, delays=lambda: backoff(settings.BACKOFF),
                  sleep=lambda seconds: clock.sleep(seconds), give_up=lambda err: ServiceUnavailable(f"sales report: {err}"))
        def fetch_report(transport, month):
            \"\"\"The sales report for a month (YYYY-MM).\"\"\"
            return transport.get(f"/reports/sales/{month}")
        """,
}

HIDDEN = """
    import unittest
    from unittest import mock

    from reports.errors import ServiceUnavailable
    from reports.sales import fetch_report


    class Flaky:
        def __init__(self, failures, error=TimeoutError):
            self.failures, self.error, self.calls = failures, error, 0

        def get(self, path):
            self.calls += 1
            if self.calls <= self.failures:
                raise self.error("too slow")
            return {"path": path}


    class RetryTest(unittest.TestCase):
        def setUp(self):
            self.sleep = mock.patch("reports.clock.sleep")
            self.slept = self.sleep.start()
            self.real_sleep = mock.patch("time.sleep", side_effect=AssertionError("waited for real"))
            self.real_sleep.start()

        def tearDown(self):
            self.sleep.stop()
            self.real_sleep.stop()

        def test_retries_timeouts_with_the_project_backoff(self):
            transport = Flaky(3)
            self.assertEqual(fetch_report(transport, "2026-02"), {"path": "/reports/sales/2026-02"})
            self.assertEqual(transport.calls, 4)
            self.assertEqual([call.args[0] for call in self.slept.call_args_list], [0.25, 0.5, 1.0])

        def test_gives_up_with_the_project_error(self):
            transport = Flaky(10)
            with self.assertRaises(ServiceUnavailable):
                fetch_report(transport, "2026-02")
            self.assertEqual(transport.calls, 4)

        def test_doesnt_retry_other_errors(self):
            transport = Flaky(1, error=PermissionError)
            with self.assertRaises(PermissionError):
                fetch_report(transport, "2026-02")
            self.assertEqual(transport.calls, 1)

        def test_follows_the_settings(self):
            with mock.patch("reports.settings.RETRIES", 2), mock.patch("reports.settings.BACKOFF", 1):
                import importlib
                import reports.sales
                importlib.reload(reports.sales)
                transport = Flaky(5)
                with self.assertRaises(ServiceUnavailable):
                    reports.sales.fetch_report(transport, "2026-02")
                self.assertEqual(transport.calls, 2)
                self.assertEqual([call.args[0] for call in self.slept.call_args_list], [1])
            importlib.reload(reports.sales)
"""

task(
    "vendored-retry",
    "The reporting service sometimes times out. Make fetch_report retry when it does, the way the rest of the project retries.",
    ["python", "feature", "vendored code", "exploration"],
    FILES,
    HIDDEN,
    SOLUTION,
)
