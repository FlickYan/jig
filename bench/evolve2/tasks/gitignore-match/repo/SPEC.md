# is_ignored(path, gitignores, is_dir=False) -> bool

Whether git would ignore a path, given the repository's `.gitignore` files (and no other ignore files).
`gitignores` maps each directory that has a `.gitignore` to the file's lines: `""` is the repository's
root, and `"src"` or `"src/app"` are directories in it. `path` is relative to the root, with `/` between
its parts and no leading `/` or `./` (`src/app/main.py`). `is_dir` says whether the path itself is a
directory; its parents always are.

## Patterns

1. A blank line matches nothing, and a line starting with `#` is a comment. A backslash in front of a
   first `#` or `!` makes it literal: `\#notes` matches `#notes`, and `\!important` matches `!important`.
2. Trailing spaces are removed, unless the last of them is escaped with a backslash: `name\ ` matches
   `name ` (with the space). Spaces anywhere else are part of the pattern.
3. A pattern starting with `!` is negated: a path it matches is not ignored, even if an earlier pattern
   ignored it. When several patterns match a path, the last one decides (and see rule 12).
4. A pattern ending in `/` matches only directories: `build/` matches a directory called `build` (and so,
   by rule 9, everything in it), but not a file called `build`. The `/` is then removed for the rules
   below.
5. A pattern with a `/` at the start or in the middle is relative to the directory of its `.gitignore`:
   in the root's, `/todo` matches `todo` but not `src/todo`, and `doc/frotz` matches `doc/frotz` but not
   `a/doc/frotz`. A leading `/` is then removed. A pattern with no such `/` matches a name at any depth
   below its directory: `frotz` matches `frotz` and `a/b/frotz`.
6. `*` matches any run of characters except `/`, including none; `?` matches one character except `/`;
   and `[...]` matches one character from a set, like `[abc]` or a range `[a-z]`, or one not in it with
   `!` first, like `[!0-9]`. None of them matches `/`. A backslash makes the next character literal: `\*`
   matches `*`.
7. `**` as a whole part of a pattern (between slashes, or at either end) matches any number of
   directories: `**/foo` matches `foo` at any depth; `abc/**` matches everything inside `abc`, at any
   depth, but not `abc` itself; `a/**/b` matches `a/b`, `a/x/b` and `a/x/y/b`. Anywhere else, `**` is the
   same as `*`.
8. Matching is case-sensitive.

## Which paths are ignored

9. A path is ignored if any of its parent directories is ignored. Each parent is decided like any
   directory, from the top down: for `a/b/c.txt`, first `a`, then `a/b`. So nothing inside an ignored
   directory can be brought back, not even by a negated pattern that matches it: with `logs/` and then
   `!logs/keep.txt`, `logs/keep.txt` is still ignored (`logs/*` would ignore what is in `logs` instead,
   and let the negation work).
10. A path whose parents aren't ignored is ignored if the last pattern that matches it is not negated;
    it is not ignored if that pattern is negated, or if no pattern matches it.

## Several files

11. A `.gitignore`'s patterns apply only to paths inside its directory (not to the directory itself), and
    are matched against the path relative to that directory: in `src/.gitignore`, `/out` matches
    `src/out` but not `out`, `gen/` matches a directory `gen` anywhere under `src`, and `sub/*.tmp` matches
    `src/sub/a.tmp`.
12. A deeper directory's file takes precedence: of all the patterns that match a path, from all the
    files, the last one decides when the files are read from the root down (a file in `src/app` after
    the one in `src`, after the root's) and each file from top to bottom.
13. The `.gitignore` of an ignored directory changes nothing: by rule 9, everything in that directory is
    ignored whatever it says.
