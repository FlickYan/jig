from reports import clock, settings
from reports.errors import ServiceUnavailable
from vendor.retrying_lite import backoff, retrying


@retrying(on=(TimeoutError,), attempts=settings.RETRIES, delays=lambda: backoff(settings.BACKOFF),
          sleep=lambda seconds: clock.sleep(seconds), give_up=lambda err: ServiceUnavailable(f"customers: {err}"))
def fetch_customers(transport):
    return transport.get("/customers")
