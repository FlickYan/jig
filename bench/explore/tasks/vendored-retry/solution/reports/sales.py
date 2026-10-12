from reports import clock, settings
from reports.errors import ServiceUnavailable
from vendor.retrying_lite import backoff, retrying


@retrying(on=(TimeoutError,), attempts=settings.RETRIES, delays=lambda: backoff(settings.BACKOFF),
          sleep=lambda seconds: clock.sleep(seconds), give_up=lambda err: ServiceUnavailable(f"sales report: {err}"))
def fetch_report(transport, month):
    """The sales report for a month (YYYY-MM)."""
    return transport.get(f"/reports/sales/{month}")
