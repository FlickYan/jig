# render(template, context) -> str

Renders a template with values from `context`, a dict.

1. `{{ name }}` is replaced by the value of `name`, HTML-escaped: `&` `<` `>` `"` `'` become
   `&amp;` `&lt;` `&gt;` `&quot;` `&#39;`. Spaces inside the braces are optional: `{{name}}` works.
2. `{{{ name }}}` inserts the value without escaping.
3. Dotted names look into nested values: `{{ user.name }}` is `context["user"]["name"]`, or the
   attribute `name` of `context["user"]` if that isn't a dict. A name that can't be found renders as
   the empty string, not an error.
4. Values are converted with `str`, except that `True` and `False` become `true` and `false`, and
   `None` becomes the empty string.
5. Filters follow a `|`, and chain from left to right: `{{ name | upper }}`, `{{ name | lower }}`,
   `{{ name | default:"anon" }}` (used when the value is missing, `None` or the empty string), and
   `{{ text | truncate:10 }}` (at most 10 characters: a longer value is cut to 9 and `…` added).
   Escaping happens after the filters.
6. `{{!-- anything --}}` is a comment and renders as nothing.
7. An unclosed `{{`, an unknown filter, or a filter argument of the wrong kind raises `ValueError`.
