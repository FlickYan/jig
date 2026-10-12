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
