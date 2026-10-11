from dataclasses import dataclass


@dataclass
class Reminder:
    time: str  # "HH:MM", in the reminder's time zone
    zone: str  # an IANA time zone, like "Europe/London"
    days: str = "daily"  # "daily", or "weekdays" (Monday to Friday)
