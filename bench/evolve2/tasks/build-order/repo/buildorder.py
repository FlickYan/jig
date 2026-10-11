class CycleError(ValueError):
    """Some targets depend on each other in a circle; `cycle` lists one such circle."""

    def __init__(self, cycle):
        super().__init__("cycle: " + " -> ".join(cycle + cycle[:1]))
        self.cycle = cycle


def build_order(targets):
    """The order to build targets in. See SPEC.md."""
    raise NotImplementedError
