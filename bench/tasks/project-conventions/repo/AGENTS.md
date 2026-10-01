# Notes for coding agents

- Money is always an integer number of cents. Never use floats for money, not even in intermediate steps:
  no `/`, no `float()`. Use `//`, `%` and `divmod`.
- Every public function has type hints and a docstring, and is listed in its module's `__all__`.
- Record every change in CHANGELOG.md, as a line starting with "- " under "## Unreleased".
- Run the tests with `python3 -m unittest discover -s tests -t .`
