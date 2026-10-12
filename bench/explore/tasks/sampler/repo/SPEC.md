# draw(n, a, rng)

Returns a list of `n` independent samples from the distribution on the real line whose density is
proportional to

    exp(-x**4 + a * x**2)

for any real `a`. The demand model uses values of `a` from -5 to 5: below 0 the samples crowd
around 0, and above it they split between a peak on each side.

- Use only `rng`, a `random.Random`, for randomness, so that the same seed gives the same samples.
- The samples must follow the distribution; the tests compare them with it.
- 100,000 samples must take less than 2 seconds, for any `a` from -5 to 5.
