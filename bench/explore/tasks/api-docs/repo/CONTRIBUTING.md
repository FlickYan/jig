# Contributing

- Every public function has a docstring whose first line says what it returns or does.
- docs/api.md is generated from the docstrings: run `make docs` after changing a public function,
  and commit the result. Don't edit it by hand; CI checks that it matches.
