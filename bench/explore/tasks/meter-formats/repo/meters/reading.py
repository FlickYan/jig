from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Reading:
    meter: str
    time: datetime
    kwh: float
