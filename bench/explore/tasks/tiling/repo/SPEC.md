# count_tilings(width, length)

The number of ways to cover a floor `width` tiles wide and `length` tiles long with 1x1 square tiles
and 1x2 tiles (laid along the floor or across it), modulo 1,000,000,007.

- `width` is from 1 to 5, and `length` from 0 to 1,000,000,000 (a corridor in the new warehouse).
  A floor of length 0 has exactly one tiling: no tiles.
- Two tilings are different if some tile covers different cells.
- count_tilings must answer within a second for any width and length in those ranges.
