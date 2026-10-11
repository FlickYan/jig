import importlib.util
from maketask import task
from patchcases import GROUPS

spec = importlib.util.spec_from_file_location("p", "patch_solution.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
DIFFS = [({"a": 1}, {"a": 1}), (1, 2), ({"b": 1, "a": 2, "d": [1]}, {"a": 3, "c": 4, "d": [1]}), ({"a/b": 1, "m~n": 2}, {"a/b": 5}), ([1, 2, 3], [1, 5]), ([1], [1, 2, 3]),
         ([1, 2, 3, 4], [1]), ({"x": [{"a": 1}, {"b": 2}]}, {"x": [{"a": 1, "c": 3}]}), ({"a": [1]}, {"a": {"0": 1}}), ({"t": True}, {"t": 1}), ({"n": 1}, {"n": 1.0}),
         (None, {}), ([], {"a": []}), ({"k": [1, [2, 3]]}, {"k": [1, [2], 4]}), ({"z": 1, "y": {"q": 0}}, {"y": {"q": False}, "x": None})]
DIFF_ROWS = [(a, b, m.diff(a, b)) for a, b in DIFFS]

methods = []
for method, cases in GROUPS.items():
    body = "\n".join(f"            ({name!r}, {doc!r}, {patch!r}, {want!r})," for name, doc, patch, want in cases)
    methods.append(f"    def {method}(self):\n        self.check([\n{body}\n        ])\n")

hidden = '''
import copy
import random
import unittest

from jsonpatch_lite import PatchError, apply_patch, diff


def typed(value):
    """The value with every leaf's type, since 1 == 1.0 == True in Python."""
    if isinstance(value, dict):
        return {key: typed(item) for key, item in value.items()}
    if isinstance(value, list):
        return [typed(item) for item in value]
    return (type(value).__name__, value)


def same(a, b):
    """Equal as the test operation compares (rule 9)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


DIFF_ROWS = ''' + repr(DIFF_ROWS) + '''


class TestSpec(unittest.TestCase):
    def check(self, cases):
        """Each case: a document, a patch, and the result, or None if the patch must fail."""
        for name, document, patch, expected in cases:
            with self.subTest(name):
                before = copy.deepcopy(document)
                if expected is None:
                    with self.assertRaises(PatchError):
                        apply_patch(document, patch)
                else:
                    self.assertEqual(typed(apply_patch(document, patch)), typed(expected))
                self.assertEqual(typed(document), typed(before), "the document was changed")

''' + "\n".join(methods) + '''
    def test_a_failed_patch_applies_nothing(self):
        document = {"a": 1, "list": [1, 2]}
        with self.assertRaises(PatchError):
            apply_patch(document, [{"op": "add", "path": "/b", "value": 2}, {"op": "remove", "path": "/list/0"}, {"op": "remove", "path": "/missing"}])
        self.assertEqual(document, {"a": 1, "list": [1, 2]})

    def test_the_patch_is_not_changed(self):
        patch = [{"op": "add", "path": "/a", "value": {"x": [1]}}, {"op": "add", "path": "/a/x/-", "value": 2}, {"op": "add", "path": "/a/y", "value": 3}]
        self.assertEqual(apply_patch({}, patch), {"a": {"x": [1, 2], "y": 3}})
        self.assertEqual(patch[0]["value"], {"x": [1]})

    def test_a_patch_is_a_list(self):
        with self.assertRaises(PatchError):
            apply_patch({}, {"op": "add", "path": "/a", "value": 1})

    def test_diff_makes_exactly_this_patch(self):
        for source, target, expected in DIFF_ROWS:
            with self.subTest(source=source, target=target):
                self.assertEqual(typed(diff(source, target)), typed(expected))

    def test_diff_then_apply_gives_the_target(self):
        rng = random.Random(9)

        def value(depth):
            r = rng.random()
            if depth == 0 or r < 0.4:
                return rng.choice([0, 1, 1.0, 2, True, False, None, "x", "y", ""])
            if r < 0.7:
                return [value(depth - 1) for _ in range(rng.randrange(4))]
            return {rng.choice(["a", "b", "c", "a/b", "m~n", ""]): value(depth - 1) for _ in range(rng.randrange(4))}

        for _ in range(500):
            source, target = value(3), value(3)
            before = copy.deepcopy(source)
            with self.subTest(source=source, target=target):
                self.assertTrue(same(apply_patch(source, diff(source, target)), target))
                self.assertEqual(typed(source), typed(before))

    def test_a_diff_holds_copies(self):
        target = {"a": {"b": [1]}}
        patch = diff({}, target)
        target["a"]["b"].append(2)
        self.assertEqual(patch, [{"op": "add", "path": "/a", "value": {"b": [1]}}])

    def test_patch_error_is_a_value_error(self):
        self.assertTrue(issubclass(PatchError, ValueError))


if __name__ == "__main__":
    unittest.main()
'''

SPEC = r'''
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
'''

task(
    "json-patch",
    "Implement apply_patch and diff in jsonpatch_lite.py so that they follow SPEC.md exactly.",
    ["python", "spec", "data"],
    {
        "SPEC.md": SPEC,
        "jsonpatch_lite.py": '''
            class PatchError(ValueError):
                """The patch can't be applied: nothing of it was."""


            def apply_patch(document, patch):
                """The document with the JSON Patch applied. See SPEC.md."""
                raise NotImplementedError


            def diff(source, target):
                """A JSON Patch that turns source into target. See SPEC.md."""
                raise NotImplementedError
        ''',
        "tests/test_jsonpatch_lite.py": '''
            import unittest

            from jsonpatch_lite import PatchError, apply_patch


            class TestBasics(unittest.TestCase):
                def test_add_and_remove(self):
                    patch = [{"op": "add", "path": "/b", "value": 2}, {"op": "remove", "path": "/a"}]
                    self.assertEqual(apply_patch({"a": 1}, patch), {"b": 2})

                def test_failed_test(self):
                    with self.assertRaises(PatchError):
                        apply_patch({"a": 1}, [{"op": "test", "path": "/a", "value": 2}])


            if __name__ == "__main__":
                unittest.main()
        ''',
    },
    hidden,
    {"jsonpatch_lite.py": open("patch_solution.py").read()},
)
