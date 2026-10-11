# satisfies(version, range) -> bool

Whether a version satisfies a range, as npm's semver does it.

1. A version is `MAJOR.MINOR.PATCH`, each a number without leading zeros, optionally followed by
   `-PRERELEASE` (dot-separated identifiers of letters, digits and hyphens) and `+BUILD`. Build
   metadata is ignored when comparing. A leading `v` is allowed: `v1.2.3`.
2. Precedence: compare major, minor and patch as numbers. A pre-release version is lower than the
   release with the same numbers (`1.0.0-alpha < 1.0.0`). Two pre-releases compare identifier by
   identifier: numeric identifiers as numbers, others as text (ASCII order), and a numeric identifier
   is lower than a non-numeric one. If all shared identifiers are equal, the one with more identifiers
   is higher (`1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 <
   1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0`).
3. A range is one or more comparator sets separated by `||`; it is satisfied if any set is. A set is
   one or more comparators separated by spaces, all of which must hold. A comparator is an operator
   (`>`, `>=`, `<`, `<=`, `=`, or none, which means `=`) followed by a version.
4. Caret ranges allow changes that don't modify the left-most non-zero number: `^1.2.3` is
   `>=1.2.3 <2.0.0`, `^0.2.3` is `>=0.2.3 <0.3.0`, `^0.0.3` is `>=0.0.3 <0.0.4`.
5. Tilde ranges allow patch changes: `~1.2.3` is `>=1.2.3 <1.3.0`, `~1.2` is `>=1.2.0 <1.3.0`,
   `~1` is `>=1.0.0 <2.0.0`.
6. X-ranges: `*` or an empty range matches every release; `1.x` (or `1.*`, or just `1`) is
   `>=1.0.0 <2.0.0`; `1.2.x` (or `1.2`) is `>=1.2.0 <1.3.0`.
7. A pre-release version satisfies a comparator set only if some comparator in that set names a
   version with the same major, minor and patch that has a pre-release itself: `1.2.3-beta.2`
   satisfies `>=1.2.3-beta.1 <1.3.0`, but `1.3.0-beta` does not satisfy `>=1.2.0`, and `1.2.3-beta`
   does not satisfy `*` or `^1.2.0`.
8. A version or range that isn't valid raises `ValueError`.
