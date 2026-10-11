# apply_patch(document, patch) -> the patched document

Applies a JSON Patch (RFC 6902) to a document made of dicts, lists, strings, numbers, booleans and `None`,
and returns the result. Neither the document nor the patch is ever changed. If any operation fails,
`PatchError` (defined in `jsonpatch_lite.py`, a subclass of `ValueError`) is raised, and nothing of the
patch is applied.

## Paths

1. A path is a JSON Pointer (RFC 6901): `""` is the whole document; anything else starts with `/`,
   followed by reference tokens separated by `/`. In a token, `~1` stands for `/` and `~0` for `~`,
   decoded in that order (so `~01` is the text `~1`); any other `~` is invalid. `/` alone is the token
   `""`, the empty key.
2. In a dict, a token is a key, whatever it looks like (`/0` is the key `"0"`). In a list, a token is an
   index: `0`, or digits with no leading zero (`01` is invalid), less than the list's length. The token
   `-` stands for the position after the last element, and is allowed only where a value is added (by
   `add`, or where `move` and `copy` add it).
3. Every step of a path must exist: a missing key, an index out of range, or a step into a string,
   number, boolean or `None` makes the operation fail.

## Operations

The patch is a list of operations, applied in order, each to the result of the one before. An operation
is a dict with `"op"` and `"path"` (a string), and the members its op needs, below; a missing member, a
`"path"` or `"from"` that isn't a string, or an unknown op fails. Other members are ignored.

4. `add`, with `"value"`: if the path is `""`, the value becomes the whole document. Otherwise the path's
   parent (the path without its last token) must exist and be a dict or a list. In a dict, the key is
   set, added or replacing what was there. In a list, the value is inserted at the index (from 0 to the
   length; the length, or `-`, appends), and later elements move along.
5. `remove`: the value at the path must exist, and is removed; in a list, later elements move back.
   Removing `""`, the whole document, fails.
6. `replace`, with `"value"`: the value at the path must exist, and is replaced. `""` replaces the whole
   document.
7. `move`, with `"from"`: the value at `"from"` is removed, then added at `"path"`, as `remove` and `add`
   would. A path inside `"from"` (with `"from"` as its first tokens, and more after them) fails; moving
   to the same path changes nothing.
8. `copy`, with `"from"`: a deep copy of the value at `"from"` is added at `"path"`, as `add` would.
9. `test`, with `"value"`: the value at the path must equal `"value"`, or the patch fails. Numbers are
   equal if they are equal as numbers (`1` equals `1.0`), but booleans aren't numbers (`true` isn't `1`,
   `false` isn't `0`); strings and `None` equal only themselves; lists are equal if they are the same
   length with equal elements in order, and dicts if they have the same keys with equal values, in any
   order.

## diff(source, target) -> a patch

`diff` makes a patch that `apply_patch(source, patch)` turns into `target` (equal as `test` compares,
rule 9), and makes it exactly this way:

10. If `source` and `target` are equal (rule 9), nothing.
11. If both are dicts: for each key of either, in sorted order, a `remove` if only `source` has it, an
    `add` of the target's value if only `target` has it, and otherwise what rules 10 to 13 make for the
    two values, at the key's path.
12. If both are lists: what rules 10 to 13 make for each index both have, from the first; then, if
    `target` is longer, an `add` with the path `-` for each of its extra elements, in order; or, if
    `source` is longer, a `remove` for each of its extra elements, from the last one back.
13. Anything else (different types, or values that differ) is a `replace` with the target's value.
14. Paths are JSON Pointers to the place in `source`, from `""` for the whole document, with `~` written
    `~0` and `/` written `~1` in keys. The values in the patch are copies, not the target's own objects,
    and operations have only the members they need (`op`, `path`, and `value` for `add` and `replace`).
