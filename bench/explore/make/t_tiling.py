"""tiling: the visible tests use short floors; the spec's floors are up to a billion tiles long.

What the agent must do beyond its first check: the project's own tests count tilings of floors a few
tiles long, which a search over every tiling answers. SPEC.md asks for lengths up to 1,000,000,000 within
a second, and widths up to 5: a count over columns (a transfer matrix) raised to the length by repeated
squaring. A search, or a loop over the length, passes the visible tests and fails the hidden ones.
"""
from maketask import task

REFERENCE = '''
MOD = 1_000_000_007


def _transitions(width):
    """T[a][b]: the ways to fill one column whose cells in mask a are already covered (by dominoes from the
    column before), covering mask b of the next column with dominoes that stick out of this one."""
    size = 1 << width
    T = [[0] * size for _ in range(size)]

    def place(row, filled, sticking_out, start):
        if row == width:
            T[start][sticking_out] += 1
            return
        if filled >> row & 1:
            place(row + 1, filled, sticking_out, start)
            return
        place(row + 1, filled | 1 << row, sticking_out, start)  # a square
        place(row + 1, filled | 1 << row, sticking_out | 1 << row, start)  # a domino along the floor
        if row + 1 < width and not filled >> (row + 1) & 1:  # a domino across it
            place(row + 2, filled | 3 << row, sticking_out, start)

    for start in range(size):
        place(0, start, 0, start)
    return T


def _multiply(A, B):
    product = []
    for row in A:
        sums = [0] * len(B[0])
        for k, a in enumerate(row):
            if a:
                for j, b in enumerate(B[k]):
                    sums[j] += a * b
        product.append([s % MOD for s in sums])
    return product


def count_tilings(width, length):
    """The ways to cover a width x length floor with 1x1 squares and 1x2 dominoes, modulo 1,000,000,007."""
    if length == 0:
        return 1
    power = _transitions(width)
    result = [[int(i == j) for j in range(len(power))] for i in range(len(power))]
    while length:
        if length & 1:
            result = _multiply(result, power)
        power = _multiply(power, power)
        length >>= 1
    return result[0][0]
'''


def brute(width, length):
    """Every tiling, one by one: only for small floors, to check the reference."""
    covered = [[False] * length for _ in range(width)]

    def go(cell):
        if cell == width * length:
            return 1
        r, c = cell % width, cell // width
        if covered[r][c]:
            return go(cell + 1)
        total = 0
        covered[r][c] = True
        total += go(cell + 1)
        if r + 1 < width and not covered[r + 1][c]:
            covered[r + 1][c] = True
            total += go(cell + 1)
            covered[r + 1][c] = False
        if c + 1 < length and not covered[r][c + 1]:
            covered[r][c + 1] = True
            total += go(cell + 1)
            covered[r][c + 1] = False
        covered[r][c] = False
        return total

    return go(0)


namespace = {}
exec(REFERENCE, namespace)
count = namespace["count_tilings"]
SMALL = {f"{w}x{n}": brute(w, n) % 1_000_000_007 for w in range(1, 5) for n in range(0, 6)}
assert all(count(int(k.split("x")[0]), int(k.split("x")[1])) == v for k, v in SMALL.items())
LARGE = {f"{w}x{n}": count(w, n) for w in range(1, 6) for n in (10**9, 123_456_789, 1000)}

FILES = {
    "README.md": """
        # floors

        Quotes for the tiling company: how many different ways a floor can be tiled. See SPEC.md.
        """,
    "SPEC.md": """
        # count_tilings(width, length)

        The number of ways to cover a floor `width` tiles wide and `length` tiles long with 1x1 square tiles
        and 1x2 tiles (laid along the floor or across it), modulo 1,000,000,007.

        - `width` is from 1 to 5, and `length` from 0 to 1,000,000,000 (a corridor in the new warehouse).
          A floor of length 0 has exactly one tiling: no tiles.
        - Two tilings are different if some tile covers different cells.
        - count_tilings must answer within a second for any width and length in those ranges.
        """,
    "floors/__init__.py": "",
    "floors/tiles.py": '''
        def count_tilings(width, length):
            """The ways to cover a width x length floor with 1x1 squares and 1x2 dominoes, modulo 1,000,000,007."""
            raise NotImplementedError
        ''',
    "tests/__init__.py": "",
    "tests/test_tiles.py": """
        import unittest

        from floors.tiles import count_tilings


        class TilesTest(unittest.TestCase):
            def test_a_strip_two_wide(self):
                self.assertEqual([count_tilings(2, n) for n in range(1, 5)], [2, 7, 22, 71])

            def test_a_small_room(self):
                self.assertEqual(count_tilings(3, 2), 22)
        """,
}

HIDDEN = f'''
    import time
    import unittest

    from floors.tiles import count_tilings

    SMALL = {SMALL!r}
    LARGE = {LARGE!r}


    class TilingTest(unittest.TestCase):
        def test_small_floors_against_counting_every_tiling(self):
            for key, expected in SMALL.items():
                width, length = map(int, key.split("x"))
                self.assertEqual(count_tilings(width, length), expected, key)

        def test_long_floors(self):
            for key, expected in LARGE.items():
                width, length = map(int, key.split("x"))
                started = time.perf_counter()
                self.assertEqual(count_tilings(width, length), expected, key)
                self.assertLess(time.perf_counter() - started, 2, key)
'''

task(
    "tiling",
    "Implement count_tilings in floors/tiles.py so that it follows SPEC.md.",
    ["python", "spec", "algorithms", "generalization"],
    FILES,
    HIDDEN,
    {"floors/tiles.py": REFERENCE},
)
