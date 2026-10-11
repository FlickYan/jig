"""An arithmetic evaluator. See SPEC.md."""
import re


class EvalError(ValueError):
    """The expression can't be evaluated."""


TOKEN = re.compile(r"(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([A-Za-z_]\w*)|(\*\*|//|<=|>=|==|!=|[-+*/%(),<>])")
KEYWORDS = {"and", "or", "not", "if", "else", "True", "False"}
COMPARISONS = {"<", "<=", ">", ">=", "==", "!="}
FUNCTIONS = {"abs": (1, 1, abs), "min": (1, None, lambda *a: min(a)), "max": (1, None, lambda *a: max(a)), "round": (1, 2, round)}


def evaluate(expression, variables=None):
    tree = _Parser(expression).parse()
    return _evaluate(tree, variables or {})


class _Parser:
    def __init__(self, text):
        self.tokens = []
        i = 0
        while i < len(text):
            if text[i] in " \t":
                i += 1
                continue
            match = TOKEN.match(text, i)
            if not match:
                raise EvalError(f"unexpected character {text[i]!r} at {i}")
            kind = "number" if match.group(1) else ("keyword" if match.group() in KEYWORDS else "name") if match.group(2) else "op"
            self.tokens.append((kind, match.group(), i))
            i = match.end()
        self.position = 0

    def peek(self):
        return self.tokens[self.position] if self.position < len(self.tokens) else None

    def take(self):
        token = self.peek()
        if token is None:
            raise EvalError("unexpected end")
        self.position += 1
        return token

    def unexpected(self, token):
        raise EvalError(f"unexpected {token[1]!r} at {token[2]}")

    def expect(self, text):
        token = self.take()
        if token[1] != text or token[0] not in ("op", "keyword"):
            self.unexpected(token)

    def at(self, *texts):
        token = self.peek()
        return token is not None and token[0] in ("op", "keyword") and token[1] in texts

    def parse(self):
        tree = self.conditional()
        if self.peek() is not None:
            self.unexpected(self.peek())
        return tree

    def conditional(self):
        tree = self.disjunction()
        if self.at("if"):
            self.take()
            test = self.disjunction()
            self.expect("else")
            return ("if", tree, test, self.conditional())
        return tree

    def disjunction(self):
        tree = self.conjunction()
        while self.at("or"):
            self.take()
            tree = ("or", tree, self.conjunction())
        return tree

    def conjunction(self):
        tree = self.inversion()
        while self.at("and"):
            self.take()
            tree = ("and", tree, self.inversion())
        return tree

    def inversion(self):
        if self.at("not"):
            self.take()
            return ("not", self.inversion())
        return self.comparison()

    def comparison(self):
        first = self.sum()
        rest = []
        while self.at(*COMPARISONS):
            rest.append((self.take()[1], self.sum()))
        return ("compare", first, rest) if rest else first

    def sum(self):
        tree = self.product()
        while self.peek() and self.peek()[1] in ("+", "-") and self.peek()[0] == "op":
            tree = (self.take()[1], tree, self.product())
        return tree

    def product(self):
        tree = self.unary()
        while self.peek() and self.peek()[1] in ("*", "/", "//", "%") and self.peek()[0] == "op":
            tree = (self.take()[1], tree, self.unary())
        return tree

    def unary(self):
        token = self.peek()
        if token and token[0] == "op" and token[1] in ("+", "-"):
            self.take()
            return ("neg" if token[1] == "-" else "pos", self.unary())
        return self.power()

    def power(self):
        tree = self.atom()
        token = self.peek()
        if token and token[0] == "op" and token[1] == "**":
            self.take()
            return ("**", tree, self.unary())
        return tree

    def atom(self):
        token = self.take()
        kind, text, _ = token
        if kind == "number":
            return ("number", float(text) if any(c in text for c in ".eE") else int(text))
        if kind == "keyword" and text in ("True", "False"):
            return ("number", text == "True")
        if kind == "name":
            following = self.peek()
            if following and following[0] == "op" and following[1] == "(":
                self.take()
                args = []
                if not self.at(")"):
                    args.append(self.conditional())
                    while self.at(","):
                        self.take()
                        args.append(self.conditional())
                self.expect(")")
                return ("call", text, args)
            return ("name", text)
        if kind == "op" and text == "(":
            tree = self.conditional()
            self.expect(")")
            return tree
        self.unexpected(token)


def _evaluate(tree, variables):
    kind = tree[0]
    if kind == "number":
        return tree[1]
    if kind == "name":
        if tree[1] not in variables:
            raise EvalError(f"unknown name {tree[1]!r}")
        return variables[tree[1]]
    if kind == "call":
        name, args = tree[1], tree[2]
        if name not in FUNCTIONS:
            raise EvalError(f"unknown function {name!r}")
        low, high, function = FUNCTIONS[name]
        if len(args) < low or (high is not None and len(args) > high):
            raise EvalError(f"wrong number of arguments to {name}")
        return function(*[_evaluate(arg, variables) for arg in args])
    if kind == "if":
        return _evaluate(tree[1] if _evaluate(tree[2], variables) else tree[3], variables)
    if kind == "or":
        left = _evaluate(tree[1], variables)
        return left if left else _evaluate(tree[2], variables)
    if kind == "and":
        left = _evaluate(tree[1], variables)
        return _evaluate(tree[2], variables) if left else left
    if kind == "not":
        return not _evaluate(tree[1], variables)
    if kind == "compare":
        left = _evaluate(tree[1], variables)
        for operator, operand in tree[2]:
            right = _evaluate(operand, variables)
            if not {"<": left < right, "<=": left <= right, ">": left > right, ">=": left >= right, "==": left == right, "!=": left != right}[operator]:
                return False
            left = right
        return True
    if kind == "neg":
        return -_evaluate(tree[1], variables)
    if kind == "pos":
        return +_evaluate(tree[1], variables)
    left, right = _evaluate(tree[1], variables), _evaluate(tree[2], variables)
    try:
        result = {"+": lambda: left + right, "-": lambda: left - right, "*": lambda: left * right, "/": lambda: left / right,
                  "//": lambda: left // right, "%": lambda: left % right, "**": lambda: left ** right}[kind]()
    except ZeroDivisionError:
        raise EvalError("division by zero") from None
    if isinstance(result, complex):
        raise EvalError("not a real number")
    return result
