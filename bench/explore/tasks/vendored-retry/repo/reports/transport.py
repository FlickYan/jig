class Transport:
    """Talks to the reporting service. Tests replace it with a fake."""

    def get(self, path):
        raise NotImplementedError("no network in this sandbox")
