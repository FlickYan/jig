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
