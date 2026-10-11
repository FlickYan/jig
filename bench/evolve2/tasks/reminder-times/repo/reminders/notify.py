from .schedule import upcoming


def describe(reminder, after):
    """A line for the app: when the reminder rings next, in UTC."""
    moment = upcoming(reminder, after, count=1)[0]
    return f"next: {moment:%Y-%m-%d %H:%M} UTC"
