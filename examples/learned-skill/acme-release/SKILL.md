---
name: acme-release
description: "Cuts a release of the acme dashboard: sets the version in VERSION, package.json and src/acme/__init__.py, moves the CHANGELOG.md entries out of [Unreleased] into a dated section, runs scripts/check_versions.py, then commits and creates the annotated release tag. Use when asked to cut, ship or prepare a release, bump the version, or tag a version like 1.4.3."
---

# Cutting an acme release

Cut a release of the acme repository: set the new version everywhere it is written down, roll the
changelog, verify, commit and tag. Do the steps in order — each one below says how to tell it worked.

## 0. Before you start

- `git status --short` must print nothing. If there are unrelated changes, ask the user before
  committing them; never sweep them into the release commit silently.
- Get the version from the user's request (e.g. `1.4.4`) and today's date from the system, not from
  memory: `date +%F` prints `YYYY-MM-DD`.
- The version is written in three places and all three must match or the check in step 3 fails:
  - `VERSION` — the whole file, single line
  - `package.json` — the `"version"` field
  - `src/acme/__init__.py` — the `__version__` line

Exact strings, used verbatim (existing releases follow this shape):

| What | Value |
| --- | --- |
| Commit message | `Release v<version>` |
| Tag name | `v<version>` |
| Tag message | `acme <version>` |
| Changelog heading | `## [<version>] - <YYYY-MM-DD>` |

## 1. Set the version in the three places

```bash
printf '%s\n' "<version>" > VERSION        # e.g. printf '%s\n' "1.4.4" > VERSION
```

Then edit the `"version"` field of `package.json` and the `__version__` line of
`src/acme/__init__.py` to the same value, leaving the rest of each file alone.

Check: `cat VERSION package.json src/acme/__init__.py` shows the new version three times.

## 2. Roll the changelog

In `CHANGELOG.md`, everything under `## [Unreleased]` moves into a new section
`## [<version>] - <YYYY-MM-DD>`, inserted directly below `## [Unreleased]`. `## [Unreleased]` stays
where it is, at the top, and is left empty — do not remove or rename it. Move every subsection
(`### Added`, `### Changed`, `### Fixed`, ...) with its bullets, and don't reformat the entries.

Before:

```markdown
## [Unreleased]

### Added
- Export of the usage report as CSV.

## [<previous version>] - <previous date>
```

After (for version 1.4.4 released on 2026-10-10):

```markdown
## [Unreleased]

## [1.4.4] - 2026-10-10

### Added
- Export of the usage report as CSV.

## [<previous version>] - <previous date>
```

## 3. Verify

```bash
python3 scripts/check_versions.py
```

It must print `OK` and exit 0. Otherwise it prints what is wrong — a version mismatch (naming the
file) or a missing changelog section — so fix that and run it again. `python3 scripts/check_versions.py; echo "exit=$?"`
shows the exit code if you want it explicitly.

## 4. Commit

```bash
git add -A && git commit -m "Release v<version>"
```

Check: `git log -1 --format='%s %H'` shows `Release v<version>` and the changed files are only
`VERSION`, `package.json`, `src/acme/__init__.py` and `CHANGELOG.md` (`git show --stat HEAD`).

## 5. Tag

The tag must be annotated, so pass `-a` and `-m`; a plain `git tag v<version>` makes a lightweight
tag and is wrong here.

```bash
git tag -a v<version> -m "acme <version>"
```

## 6. Verify and report

```bash
git status --short                                  # empty
git cat-file -t v<version>                          # must print: tag
git tag -l --format='%(subject)' v<version>         # must print: acme <version>
git describe --tags --exact-match                   # must print: v<version>
```

Report the version, the commit hash, the tag, and that `check_versions.py` printed `OK`.
**Do not push** the branch or the tag unless the user asks; say in your report that nothing was
pushed.

## Pitfalls

- `check_versions.py` looks for the literal string `## [<version>] - ` — heading, space, hyphen,
  space, date. `## 1.4.4`, `## [1.4.4]` or `## [1.4.4]-2026-10-10` all fail the check.
- Changing only some of the three version locations is the most common failure. Change all three in
  one pass, then run the check.
- Don't hand-edit `CHANGELOG.md` by rewriting the whole file: move the block, so the old sections
  below stay untouched.
- `package.json` is JSON — edit the `"version"` field, and keep the rest of the file byte-identical.
- A version like `2.0.0` needs no special handling; the same steps apply.
- The date comes from `date +%F`, not from the last changelog entry or the model's sense of today.
