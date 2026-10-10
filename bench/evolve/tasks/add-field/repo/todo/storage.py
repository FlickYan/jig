import json
from dataclasses import asdict

from todo.model import Task


def save(tasks, path):
    with open(path, "w") as handle:
        json.dump([asdict(task) for task in tasks], handle, indent=2)


def load(path):
    try:
        with open(path) as handle:
            return [Task(**item) for item in json.load(handle)]
    except FileNotFoundError:
        return []
