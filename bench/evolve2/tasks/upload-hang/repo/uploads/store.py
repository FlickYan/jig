from dataclasses import dataclass


@dataclass(frozen=True)
class Upload:
    name: str
    size: int
    owner: str


class Store:
    def __init__(self):
        self.uploads = []

    def add(self, upload):
        self.uploads.append(upload)

    def names(self):
        """Every file name uploaded, once each, in order."""
        seen = []
        for upload in self.uploads:
            if upload.name not in seen:
                seen.append(upload.name)
        return sorted(seen)

    def by_owner(self, owner):
        return [upload for upload in self.uploads if upload.owner == owner]

    def total_size(self):
        return sum(upload.size for upload in self.uploads)
