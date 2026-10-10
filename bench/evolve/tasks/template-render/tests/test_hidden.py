import unittest

from templates import render


class User:
    def __init__(self, name):
        self.name = name


class TestSpec(unittest.TestCase):
    def test_escaping_all_five(self):
        self.assertEqual(render("{{x}}", {"x": "&<>\"'"}), "&amp;&lt;&gt;&quot;&#39;")

    def test_raw(self):
        self.assertEqual(render("{{{ x }}}", {"x": "<b>"}), "<b>")
        self.assertEqual(render("{{{x}}}", {"x": "a & b"}), "a & b")

    def test_dotted(self):
        self.assertEqual(render("{{ user.name }}", {"user": {"name": "Ada"}}), "Ada")
        self.assertEqual(render("{{ user.name }}", {"user": User("Grace")}), "Grace")
        self.assertEqual(render("[{{ user.missing }}][{{ nobody.name }}]", {"user": {}}), "[][]")

    def test_value_types(self):
        self.assertEqual(render("{{a}} {{b}} {{c}} {{d}}", {"a": True, "b": False, "c": None, "d": 3.5}), "true false  3.5")

    def test_filters(self):
        self.assertEqual(render("{{ n | upper }}", {"n": "ada"}), "ADA")
        self.assertEqual(render("{{ n | lower }}", {"n": "ADA"}), "ada")
        self.assertEqual(render('{{ n | default:"anon" }}', {}), "anon")
        self.assertEqual(render('{{ n | default:"anon" }}', {"n": ""}), "anon")
        self.assertEqual(render('{{ n | default:"anon" }}', {"n": None}), "anon")
        self.assertEqual(render('{{ n | default:"anon" }}', {"n": "Ada"}), "Ada")
        self.assertEqual(render("{{ t | truncate:10 }}", {"t": "abcdefghijklmnop"}), "abcdefghi…")
        self.assertEqual(render("{{ t | truncate:10 }}", {"t": "abcdefghij"}), "abcdefghij")
        self.assertEqual(render('{{ n | default:"x<y" | upper }}', {}), "X&lt;Y")

    def test_comments(self):
        self.assertEqual(render("a{{!-- hidden {{ x }} --}}b", {"x": 1}), "ab")

    def test_errors(self):
        for bad in ["{{ x", "{{ x | shout }}", "{{ x | truncate:ten }}", "{{{ x }}"]:
            with self.assertRaises(ValueError, msg=bad):
                render(bad, {"x": "y"})


if __name__ == "__main__":
    unittest.main()
