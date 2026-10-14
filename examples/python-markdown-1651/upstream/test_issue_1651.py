# -*- coding: utf-8 -*-
"""
The regression tests Python-Markdown added with its fix for issue #1651 (commit 7c265bc, in
tests/test_syntax/blocks/test_html_blocks.py), unchanged except that they sit in a file and a class of
their own, so that they can be dropped into a project the agent may have added tests to.

Copyright 2007-2023 The Python Markdown Project (v. 1.7 and later)
Copyright 2004, 2005, 2006 Yuri Takhteyev (v. 0.2-1.6b)
Copyright 2004 Manfred Stienstra (the original version)

License: BSD (see LICENSE.md for details).
"""

from markdown.test_tools import TestCase


class TestIssue1651(TestCase):

    def test_unterminated_endtag_in_code_span(self):
        """Ensure an unterminated end tag does not swallow the remaining content."""

        # https://github.com/Python-Markdown/markdown/issues/1651
        self.assertMarkdownRenders(
            'Run `cmd 2</dev/null` here.\n\nThis paragraph should not disappear.',
            self.dedent(
                '''
                <p>Run <code>cmd 2&lt;/dev/null</code> here.</p>
                <p>This paragraph should not disappear.</p>
                '''
            )
        )

    def test_additional_tail_cases(self):
        """Ensure various tail cases survive."""

        # https://github.com/Python-Markdown/markdown/issues/1651
        self.assertMarkdownRenders(
            self.dedent(
                """
                `</dev` z > q

                `</ab c` z

                `</dev/` > q

                `</dev/null` z > q

                `</ab c>` z
                """
            ),
            self.dedent(
                """
                <p><code>&lt;/dev</code> z &gt; q</p>
                <p><code>&lt;/ab c</code> z</p>
                <p><code>&lt;/dev/</code> &gt; q</p>
                <p><code>&lt;/dev/null</code> z &gt; q</p>
                <p><code>&lt;/ab c&gt;</code> z</p>
                """
            )
        )

    def test_unterminated_endtag(self):
        """Ensure an unterminated end tag is treated as text."""

        # https://github.com/Python-Markdown/markdown/issues/1651
        self.assertMarkdownRenders(
            'foo </bar\n\nbaz',
            self.dedent(
                '''
                <p>foo &lt;/bar</p>
                <p>baz</p>
                '''
            )
        )
