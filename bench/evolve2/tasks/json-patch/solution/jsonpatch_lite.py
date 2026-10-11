"""JSON Patch (RFC 6902), with JSON Pointer (RFC 6901). See SPEC.md."""
import copy
import re


class PatchError(ValueError):
    """The patch can't be applied: nothing of it was."""


def apply_patch(document, patch):
    if not isinstance(patch, list):
        raise PatchError("a patch is a list of operations")
    result = copy.deepcopy(document)
    for operation in patch:
        result = _apply(result, operation)
    return result


def _apply(document, operation):
    if not isinstance(operation, dict):
        raise PatchError("an operation is an object")
    kind = operation.get("op")
    target = _tokens(_member(operation, "path"))
    if kind == "add":
        return _add(document, target, copy.deepcopy(_member(operation, "value")))
    if kind == "remove":
        _remove(document, target)
        return document
    if kind == "replace":
        value = copy.deepcopy(_member(operation, "value"))
        _get(document, target)
        if not target:
            return value
        parent = _get(document, target[:-1])
        if isinstance(parent, dict):
            parent[target[-1]] = value
        else:
            parent[_index(target[-1], len(parent), end=False)] = value
        return document
    if kind == "move":
        source = _tokens(_member(operation, "from"))
        if len(target) > len(source) and target[:len(source)] == source:
            raise PatchError("can't move a value into itself")
        if source == target:
            _get(document, source)
            return document
        return _add(document, target, _remove(document, source))
    if kind == "copy":
        return _add(document, target, copy.deepcopy(_get(document, _tokens(_member(operation, "from")))))
    if kind == "test":
        if not _equal(_get(document, target), _member(operation, "value")):
            raise PatchError("test failed")
        return document
    raise PatchError(f"unknown op {kind!r}")


def _member(operation, name):
    if name not in operation:
        raise PatchError(f"missing {name!r}")
    value = operation[name]
    if name in ("path", "from") and not isinstance(value, str):
        raise PatchError(f"{name!r} must be a string")
    return value


def _tokens(pointer):
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise PatchError(f"not a JSON Pointer: {pointer!r}")
    tokens = []
    for raw in pointer[1:].split("/"):
        if re.search(r"~(?![01])", raw):
            raise PatchError(f"invalid escape in {pointer!r}")
        tokens.append(raw.replace("~1", "/").replace("~0", "~"))
    return tokens


def _index(token, length, end):
    if token == "-" and end:
        return length
    if not re.fullmatch(r"0|[1-9][0-9]*", token):
        raise PatchError(f"not an array index: {token!r}")
    index = int(token)
    if index > length or (index == length and not end):
        raise PatchError(f"index {index} is out of range")
    return index


def _get(document, tokens):
    for token in tokens:
        if isinstance(document, dict):
            if token not in document:
                raise PatchError(f"no member {token!r}")
            document = document[token]
        elif isinstance(document, list):
            document = document[_index(token, len(document), end=False)]
        else:
            raise PatchError(f"can't look inside {document!r}")
    return document


def _add(document, tokens, value):
    if not tokens:
        return value
    parent = _get(document, tokens[:-1])
    if isinstance(parent, dict):
        parent[tokens[-1]] = value
    elif isinstance(parent, list):
        parent.insert(_index(tokens[-1], len(parent), end=True), value)
    else:
        raise PatchError(f"can't add inside {parent!r}")
    return document


def _remove(document, tokens):
    if not tokens:
        raise PatchError("can't remove the whole document")
    parent = _get(document, tokens[:-1])
    if isinstance(parent, dict):
        if tokens[-1] not in parent:
            raise PatchError(f"no member {tokens[-1]!r}")
        return parent.pop(tokens[-1])
    if isinstance(parent, list):
        return parent.pop(_index(tokens[-1], len(parent), end=False))
    raise PatchError(f"can't remove from {parent!r}")


def _equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[key], b[key]) for key in a)
    return type(a) is type(b) and a == b


def diff(source, target):
    """A patch that turns source into target. See SPEC.md for which one."""
    patch = []
    _diff(source, target, "", patch)
    return patch


def _diff(source, target, path, patch):
    if _equal(source, target):
        return
    if isinstance(source, dict) and isinstance(target, dict):
        for key in sorted(set(source) | set(target)):
            child = f"{path}/{key.replace('~', '~0').replace('/', '~1')}"
            if key not in target:
                patch.append({"op": "remove", "path": child})
            elif key not in source:
                patch.append({"op": "add", "path": child, "value": copy.deepcopy(target[key])})
            else:
                _diff(source[key], target[key], child, patch)
        return
    if isinstance(source, list) and isinstance(target, list):
        for index in range(min(len(source), len(target))):
            _diff(source[index], target[index], f"{path}/{index}", patch)
        for value in target[len(source):]:
            patch.append({"op": "add", "path": f"{path}/-", "value": copy.deepcopy(value)})
        for index in range(len(source) - 1, len(target) - 1, -1):
            patch.append({"op": "remove", "path": f"{path}/{index}"})
        return
    patch.append({"op": "replace", "path": path, "value": copy.deepcopy(target)})
