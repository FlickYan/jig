import csv
import io


def to_csv(tasks):
    """The tasks as CSV: a header line, then one row per task."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["title", "priority", "done"])
    for task in tasks:
        writer.writerow([task.title, task.priority, "yes" if task.done else "no"])
    return buffer.getvalue()
