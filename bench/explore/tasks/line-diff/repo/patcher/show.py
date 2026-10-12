from patcher.diff import diff


def show(old_text, new_text):
    """The change as lines starting with "  ", "- " or "+ ", as the review page prints it."""
    marks = {"keep": "  ", "del": "- ", "add": "+ "}
    return "\n".join(marks[op] + line for op, line in diff(old_text.splitlines(), new_text.splitlines()))
