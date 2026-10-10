from dataclasses import dataclass

PRIORITIES = ("low", "normal", "high")


@dataclass
class Task:
    title: str
    done: bool = False
    priority: str = "normal"

    def __post_init__(self):
        if self.priority not in PRIORITIES:
            raise ValueError(f"priority must be one of {', '.join(PRIORITIES)}, not {self.priority!r}")
