def diff(old, new):
    """How to turn old into new, as ("keep" | "del" | "add", line) in order, with as few deletions and
    additions as possible: Myers' algorithm, in O((N + M) D) time for D differences."""
    n, m = len(old), len(new)
    offset = n + m + 1
    v = [0] * (2 * offset + 1)  # v[k]: the furthest x reached on diagonal k = x - y
    history = []  # v before each round d, to walk the path back
    for d in range(n + m + 1):
        history.append(v[:])
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1]):
                x = v[offset + k + 1]  # down: a line added
            else:
                x = v[offset + k - 1] + 1  # right: a line deleted
            y = x - k
            while x < n and y < m and old[x] == new[y]:
                x, y = x + 1, y + 1
            v[offset + k] = x
            if x >= n and y >= m:
                return _path(old, new, history, offset, d)
    raise AssertionError("unreachable: n + m rounds always reach the end")


def _path(old, new, history, offset, rounds):
    ops = []
    x, y = len(old), len(new)
    for d in range(rounds, 0, -1):
        v = history[d]
        k = x - y
        added = k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1])
        start_x = v[offset + k + 1] if added else v[offset + k - 1]
        start_y = start_x - (k + 1 if added else k - 1)
        mid_x = start_x if added else start_x + 1  # where the edit ends and the run of kept lines starts
        while x > mid_x:
            x, y = x - 1, y - 1
            ops.append(("keep", old[x]))
        if added:
            ops.append(("add", new[start_y]))
        else:
            ops.append(("del", old[start_x]))
        x, y = start_x, start_y
    while x > 0:
        x, y = x - 1, y - 1
        ops.append(("keep", old[x]))
    ops.reverse()
    return ops
