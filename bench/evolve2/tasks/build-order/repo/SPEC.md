# build_order(targets) -> list

The order to build targets in. `targets` maps each target's name (a string) to the list of targets it
depends on.

1. Every target comes after all the targets it depends on.
2. When several targets could come next (everything they depend on is already in the order), the one
   whose name comes first in Python's string order comes next. So the order is fixed: for
   `{"app": ["lib", "util"], "lib": ["util"], "util": [], "docs": []}` it is
   `["docs", "util", "lib", "app"]`.
3. A target may list a dependency more than once, which changes nothing. A dependency that isn't a
   target (a key of `targets`) raises `ValueError`.
4. If targets depend on each other in a circle, there is no order: `CycleError` is raised (it is defined
   in `buildorder.py`, as a subclass of `ValueError`), and its `cycle` attribute is one such circle: a
   list of targets in which each depends on the next, and the last on the first (`["a", "b", "c"]` when
   a depends on b, b on c, and c on a). A target that depends on itself is a circle of one.
5. It has to be fast: a graph may have 200,000 targets and 600,000 dependencies, with chains of
   dependencies 200,000 targets long, and the tests give `build_order` 10 seconds for such a graph (a
   good solution needs well under one).
