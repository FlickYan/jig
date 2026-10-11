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


DIFF_ROWS = [({'a': 1}, {'a': 1}, []), (1, 2, [{'op': 'replace', 'path': '', 'value': 2}]), ({'b': 1, 'a': 2, 'd': [1]}, {'a': 3, 'c': 4, 'd': [1]}, [{'op': 'replace', 'path': '/a', 'value': 3}, {'op': 'remove', 'path': '/b'}, {'op': 'add', 'path': '/c', 'value': 4}]), ({'a/b': 1, 'm~n': 2}, {'a/b': 5}, [{'op': 'replace', 'path': '/a~1b', 'value': 5}, {'op': 'remove', 'path': '/m~0n'}]), ([1, 2, 3], [1, 5], [{'op': 'replace', 'path': '/1', 'value': 5}, {'op': 'remove', 'path': '/2'}]), ([1], [1, 2, 3], [{'op': 'add', 'path': '/-', 'value': 2}, {'op': 'add', 'path': '/-', 'value': 3}]), ([1, 2, 3, 4], [1], [{'op': 'remove', 'path': '/3'}, {'op': 'remove', 'path': '/2'}, {'op': 'remove', 'path': '/1'}]), ({'x': [{'a': 1}, {'b': 2}]}, {'x': [{'a': 1, 'c': 3}]}, [{'op': 'add', 'path': '/x/0/c', 'value': 3}, {'op': 'remove', 'path': '/x/1'}]), ({'a': [1]}, {'a': {'0': 1}}, [{'op': 'replace', 'path': '/a', 'value': {'0': 1}}]), ({'t': True}, {'t': 1}, [{'op': 'replace', 'path': '/t', 'value': 1}]), ({'n': 1}, {'n': 1.0}, []), (None, {}, [{'op': 'replace', 'path': '', 'value': {}}]), ([], {'a': []}, [{'op': 'replace', 'path': '', 'value': {'a': []}}]), ({'k': [1, [2, 3]]}, {'k': [1, [2], 4]}, [{'op': 'remove', 'path': '/k/1/1'}, {'op': 'add', 'path': '/k/-', 'value': 4}]), ({'z': 1, 'y': {'q': 0}}, {'y': {'q': False}, 'x': None}, [{'op': 'add', 'path': '/x', 'value': None}, {'op': 'replace', 'path': '/y/q', 'value': False}, {'op': 'remove', 'path': '/z'}])]


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

    def test_rfc_6902_examples(self):
        self.check([
            ('A.1 add a member', {'foo': 'bar'}, [{'op': 'add', 'path': '/baz', 'value': 'qux'}], {'baz': 'qux', 'foo': 'bar'}),
            ('A.2 add an element', {'foo': ['bar', 'baz']}, [{'op': 'add', 'path': '/foo/1', 'value': 'qux'}], {'foo': ['bar', 'qux', 'baz']}),
            ('A.3 remove a member', {'baz': 'qux', 'foo': 'bar'}, [{'op': 'remove', 'path': '/baz'}], {'foo': 'bar'}),
            ('A.4 remove an element', {'foo': ['bar', 'qux', 'baz']}, [{'op': 'remove', 'path': '/foo/1'}], {'foo': ['bar', 'baz']}),
            ('A.5 replace', {'baz': 'qux', 'foo': 'bar'}, [{'op': 'replace', 'path': '/baz', 'value': 'boo'}], {'baz': 'boo', 'foo': 'bar'}),
            ('A.6 move a value', {'foo': {'bar': 'baz', 'waldo': 'fred'}, 'qux': {'corge': 'grault'}}, [{'op': 'move', 'from': '/foo/waldo', 'path': '/qux/thud'}], {'foo': {'bar': 'baz'}, 'qux': {'corge': 'grault', 'thud': 'fred'}}),
            ('A.7 move an element', {'foo': ['all', 'grass', 'cows', 'eat']}, [{'op': 'move', 'from': '/foo/1', 'path': '/foo/3'}], {'foo': ['all', 'cows', 'eat', 'grass']}),
            ('A.8 tests that pass', {'baz': 'qux', 'foo': ['a', 2, 'c']}, [{'op': 'test', 'path': '/baz', 'value': 'qux'}, {'op': 'test', 'path': '/foo/1', 'value': 2}], {'baz': 'qux', 'foo': ['a', 2, 'c']}),
            ('A.9 a test that fails', {'baz': 'qux'}, [{'op': 'test', 'path': '/baz', 'value': 'bar'}], None),
            ('A.10 add a nested object', {'foo': 'bar'}, [{'op': 'add', 'path': '/child', 'value': {'grandchild': {}}}], {'foo': 'bar', 'child': {'grandchild': {}}}),
            ('A.11 unknown members are ignored', {'foo': 'bar'}, [{'op': 'add', 'path': '/baz', 'value': 'qux', 'xyz': 123}], {'foo': 'bar', 'baz': 'qux'}),
            ('A.12 add under a missing parent', {'foo': 'bar'}, [{'op': 'add', 'path': '/baz/bat', 'value': 'qux'}], None),
            ('A.14 escape order', {'/': 9, '~1': 10}, [{'op': 'test', 'path': '/~01', 'value': 10}], {'/': 9, '~1': 10}),
            ("A.15 a string isn't a number", {'/': 9, '~1': 10}, [{'op': 'test', 'path': '/~01', 'value': '10'}], None),
            ('A.16 add an array as a value', {'foo': ['bar']}, [{'op': 'add', 'path': '/foo/-', 'value': ['abc', 'def']}], {'foo': ['bar', ['abc', 'def']]}),
        ])

    def test_pointers(self):
        self.check([
            ('slash escape', {'a/b': 1}, [{'op': 'replace', 'path': '/a~1b', 'value': 2}], {'a/b': 2}),
            ('tilde escape', {'m~n': 1}, [{'op': 'remove', 'path': '/m~0n'}], {}),
            ('the empty key', {'': 1, 'a': 2}, [{'op': 'test', 'path': '/', 'value': 1}, {'op': 'add', 'path': '/', 'value': 3}], {'': 3, 'a': 2}),
            ('a numeric key in an object', {'0': 'a'}, [{'op': 'replace', 'path': '/0', 'value': 'b'}], {'0': 'b'}),
            ('deep path', {'a': [{'b': {'c': [1, 2]}}]}, [{'op': 'add', 'path': '/a/0/b/c/1', 'value': 9}], {'a': [{'b': {'c': [1, 9, 2]}}]}),
            ('bad escape', {'a': 1}, [{'op': 'remove', 'path': '/a~2'}], None),
            ('no leading slash', {'a': 1}, [{'op': 'remove', 'path': 'a'}], None),
            ('step into a scalar', {'a': 1}, [{'op': 'add', 'path': '/a/b', 'value': 2}], None),
            ('missing member on the way', {'a': {}}, [{'op': 'add', 'path': '/a/b/c', 'value': 2}], None),
        ])

    def test_array_indexes(self):
        self.check([
            ('append at the length', {'a': [1, 2]}, [{'op': 'add', 'path': '/a/2', 'value': 3}], {'a': [1, 2, 3]}),
            ('append with -', {'a': []}, [{'op': 'add', 'path': '/a/-', 'value': 1}, {'op': 'add', 'path': '/a/-', 'value': 2}], {'a': [1, 2]}),
            ('insert at the start', {'a': [1, 2]}, [{'op': 'add', 'path': '/a/0', 'value': 0}], {'a': [0, 1, 2]}),
            ('past the end', {'a': [1, 2]}, [{'op': 'add', 'path': '/a/3', 'value': 3}], None),
            ('leading zero', {'a': [1, 2]}, [{'op': 'replace', 'path': '/a/01', 'value': 3}], None),
            ('leading zero on add', {'a': [1, 2]}, [{'op': 'add', 'path': '/a/00', 'value': 3}], None),
            ('negative index', {'a': [1, 2]}, [{'op': 'remove', 'path': '/a/-1'}], None),
            ('- only adds: remove', {'a': [1, 2]}, [{'op': 'remove', 'path': '/a/-'}], None),
            ('- only adds: replace', {'a': [1, 2]}, [{'op': 'replace', 'path': '/a/-', 'value': 3}], None),
            ('- only adds: test', {'a': [1, 2]}, [{'op': 'test', 'path': '/a/-', 'value': 2}], None),
            ('replace at the length', {'a': [1, 2]}, [{'op': 'replace', 'path': '/a/2', 'value': 3}], None),
            ('not a number', {'a': [1, 2]}, [{'op': 'remove', 'path': '/a/x'}], None),
        ])

    def test_the_whole_document(self):
        self.check([
            ('add at the root', {'a': 1}, [{'op': 'add', 'path': '', 'value': [1, 2]}], [1, 2]),
            ('replace the root', {'a': 1}, [{'op': 'replace', 'path': '', 'value': {'b': 2}}], {'b': 2}),
            ('test the root', [1, {'x': None}], [{'op': 'test', 'path': '', 'value': [1.0, {'x': None}]}], [1, {'x': None}]),
            ('remove the root', {'a': 1}, [{'op': 'remove', 'path': ''}], None),
            ('replace a member that is missing', {'a': 1}, [{'op': 'replace', 'path': '/b', 'value': 2}], None),
            ('remove a member that is missing', {'a': 1}, [{'op': 'remove', 'path': '/b'}], None),
        ])

    def test_move_and_copy(self):
        self.check([
            ('move into its own child', {'a': {'b': 1}}, [{'op': 'move', 'from': '/a', 'path': '/a/b/c'}], None),
            ('move to a key that only starts the same', {'a': 1}, [{'op': 'move', 'from': '/a', 'path': '/ab'}], {'ab': 1}),
            ('move to the same place', {'a': [1, 2]}, [{'op': 'move', 'from': '/a/1', 'path': '/a/1'}], {'a': [1, 2]}),
            ('move from a missing place', {'a': 1}, [{'op': 'move', 'from': '/b', 'path': '/c'}], None),
            ('move replaces an existing member', {'a': 1, 'b': 2}, [{'op': 'move', 'from': '/a', 'path': '/b'}], {'b': 1}),
            ('move out of an array to its end', {'a': [1, 2, 3]}, [{'op': 'move', 'from': '/a/0', 'path': '/a/-'}], {'a': [2, 3, 1]}),
            ('copy is deep', {'a': {'x': [1]}}, [{'op': 'copy', 'from': '/a', 'path': '/b'}, {'op': 'add', 'path': '/b/x/-', 'value': 2}], {'a': {'x': [1]}, 'b': {'x': [1, 2]}}),
            ('copy into its own child', {'a': {'b': 1}}, [{'op': 'copy', 'from': '/a', 'path': '/a/c'}], {'a': {'b': 1, 'c': {'b': 1}}}),
            ('copy from a missing place', {'a': 1}, [{'op': 'copy', 'from': '/b', 'path': '/c'}], None),
        ])

    def test_equality_in_test(self):
        self.check([
            ('an integer equals a float', {'n': 1.0}, [{'op': 'test', 'path': '/n', 'value': 1}], {'n': 1.0}),
            ("true isn't 1", {'t': True}, [{'op': 'test', 'path': '/t', 'value': 1}], None),
            ("0 isn't false", {'z': 0}, [{'op': 'test', 'path': '/z', 'value': False}], None),
            ('nested booleans', {'l': [1, True]}, [{'op': 'test', 'path': '/l', 'value': [1, 1]}], None),
            ('objects ignore order', {'o': {'a': 1, 'b': [2]}}, [{'op': 'test', 'path': '/o', 'value': {'b': [2.0], 'a': 1}}], {'o': {'a': 1, 'b': [2]}}),
            ('arrays keep order', {'l': [1, 2]}, [{'op': 'test', 'path': '/l', 'value': [2, 1]}], None),
            ('an extra key', {'o': {'a': 1}}, [{'op': 'test', 'path': '/o', 'value': {'a': 1, 'b': None}}], None),
            ('null is null', {'x': None}, [{'op': 'test', 'path': '/x', 'value': None}], {'x': None}),
            ("null isn't missing", {'x': None}, [{'op': 'test', 'path': '/y', 'value': None}], None),
        ])

    def test_invalid_operations(self):
        self.check([
            ('unknown op', {}, [{'op': 'merge', 'path': '/a', 'value': 1}], None),
            ('no op', {}, [{'path': '/a', 'value': 1}], None),
            ('no path', {}, [{'op': 'add', 'value': 1}], None),
            ('path not a string', {'a': [1]}, [{'op': 'remove', 'path': ['a', 0]}], None),
            ('add without a value', {}, [{'op': 'add', 'path': '/a'}], None),
            ('test without a value', {'a': None}, [{'op': 'test', 'path': '/a'}], None),
            ('move without from', {'a': 1}, [{'op': 'move', 'path': '/b'}], None),
            ("an operation that isn't an object", {}, ['add'], None),
        ])

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
