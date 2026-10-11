"""The order to build targets in. See SPEC.md."""
import heapq


class CycleError(ValueError):
    """Some targets depend on each other in a circle; `cycle` lists one such circle."""

    def __init__(self, cycle):
        super().__init__("cycle: " + " -> ".join(cycle + cycle[:1]))
        self.cycle = cycle


def build_order(targets):
    for target, dependencies in targets.items():
        for dependency in dependencies:
            if dependency not in targets:
                raise ValueError(f"{target} depends on an unknown target: {dependency}")
    waiting = {target: len(set(dependencies)) for target, dependencies in targets.items()}
    dependents = {target: [] for target in targets}
    for target, dependencies in targets.items():
        for dependency in set(dependencies):
            dependents[dependency].append(target)
    ready = [target for target, count in waiting.items() if count == 0]
    heapq.heapify(ready)
    order = []
    while ready:
        target = heapq.heappop(ready)
        order.append(target)
        for dependent in dependents[target]:
            waiting[dependent] -= 1
            if waiting[dependent] == 0:
                heapq.heappush(ready, dependent)
    if len(order) < len(targets):
        raise CycleError(_cycle(targets, {t for t, count in waiting.items() if count > 0}))
    return order


def _cycle(targets, stuck):
    """A circle among the targets that never became ready: each of them waits on another one of them."""
    seen, walk = {}, []
    target = min(stuck)
    while target not in seen:
        seen[target] = len(walk)
        walk.append(target)
        target = min(d for d in targets[target] if d in stuck)
    return walk[seen[target]:]
