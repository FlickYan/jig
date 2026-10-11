import unittest

from ignore import is_ignored


class TestSpec(unittest.TestCase):
    """Every expectation here is what git itself decides (git check-ignore, core.ignorecase off)."""

    def check(self, cases):
        for gitignores, path, is_dir, expected in cases:
            with self.subTest(gitignores=gitignores, path=path, is_dir=is_dir):
                self.assertEqual(is_ignored(path, gitignores, is_dir), expected)

    def test_any_depth_or_from_the_root(self):
        self.check([
            ({'': ['*.log']}, 'debug.log', False, True),
            ({'': ['*.log']}, 'logs/debug.log', False, True),
            ({'': ['*.log']}, 'debug.log.txt', False, False),
            ({'': ['*.log']}, 'a/b/c.log', False, True),
            ({'': ['/todo']}, 'todo', False, True),
            ({'': ['/todo']}, 'src/todo', False, False),
            ({'': ['doc/frotz']}, 'doc/frotz', False, True),
            ({'': ['doc/frotz']}, 'a/doc/frotz', False, False),
            ({'': ['frotz']}, 'frotz', False, True),
            ({'': ['frotz']}, 'a/b/frotz', False, True),
            ({'': ['frotz']}, 'frotz2', False, False),
            ({'': ['frotz']}, 'frotz/x.txt', False, True),
            ({'': ['docs/*.txt']}, 'docs/a.txt', False, True),
            ({'': ['docs/*.txt']}, 'docs/sub/a.txt', False, False),
            ({'': ['docs/*.txt']}, 'x/docs/a.txt', False, False),
        ])

    def test_directories_only(self):
        self.check([
            ({'': ['build/']}, 'build', True, True),
            ({'': ['build/']}, 'build', False, False),
            ({'': ['build/']}, 'build/out.o', False, True),
            ({'': ['build/']}, 'src/build/x.o', False, True),
            ({'': ['build/']}, 'src/build', False, False),
            ({'': ['/build/']}, 'build', True, True),
            ({'': ['/build/']}, 'sub/build', True, False),
            ({'': ['/build/']}, 'build/x', False, True),
            ({'': ['/build/']}, 'sub/build/x', False, False),
        ])

    def test_negation_and_the_last_match(self):
        self.check([
            ({'': ['*.log', '!keep.log']}, 'keep.log', False, False),
            ({'': ['*.log', '!keep.log']}, 'a/keep.log', False, False),
            ({'': ['*.log', '!keep.log']}, 'x.log', False, True),
            ({'': ['!keep.log', '*.log']}, 'keep.log', False, True),
            ({'': ['*.o', '!lib/*.o', 'lib/bad.o']}, 'lib/good.o', False, False),
            ({'': ['*.o', '!lib/*.o', 'lib/bad.o']}, 'lib/bad.o', False, True),
            ({'': ['*.o', '!lib/*.o', 'lib/bad.o']}, 'main.o', False, True),
            ({'': ['*.o', '!lib/*.o', 'lib/bad.o']}, 'lib/sub/x.o', False, True),
        ])

    def test_an_ignored_directory_hides_everything_in_it(self):
        self.check([
            ({'': ['logs/', '!logs/keep.txt']}, 'logs/keep.txt', False, True),
            ({'': ['logs/', '!logs/keep.txt']}, 'logs/x.txt', False, True),
            ({'': ['logs/*', '!logs/keep.txt']}, 'logs/keep.txt', False, False),
            ({'': ['logs/*', '!logs/keep.txt']}, 'logs/x.txt', False, True),
            ({'': ['logs/*', '!logs/keep.txt']}, 'logs', True, False),
            ({'': ['vendor/', '!vendor/keep/', '!vendor/keep/*']}, 'vendor/keep/a.go', False, True),
            ({'': ['vendor/', '!vendor/keep/', '!vendor/keep/*']}, 'vendor/b.go', False, True),
            ({'': ['out', '!out/keep']}, 'out/keep', False, True),
            ({'': ['out', '!out/keep']}, 'out', True, True),
            ({'': ['**/cache/', '!**/cache/README']}, 'a/cache/README', False, True),
            ({'': ['**/cache/', '!**/cache/README']}, 'cache', True, True),
            ({'': ['**/cache/', '!**/cache/README']}, 'a/b/cache/data', False, True),
        ])

    def test_everything_but_python(self):
        self.check([
            ({'': ['*', '!*/', '!*.py']}, 'src/a.py', False, False),
            ({'': ['*', '!*/', '!*.py']}, 'src/a.txt', False, True),
            ({'': ['*', '!*/', '!*.py']}, 'a.py', False, False),
            ({'': ['*', '!*/', '!*.py']}, 'README', False, True),
            ({'': ['*', '!*/', '!*.py']}, 'src', True, False),
        ])

    def test_double_star(self):
        self.check([
            ({'': ['**/foo']}, 'foo', False, True),
            ({'': ['**/foo']}, 'a/b/foo', False, True),
            ({'': ['**/foo']}, 'a/foo/bar', False, True),
            ({'': ['abc/**']}, 'abc/x', False, True),
            ({'': ['abc/**']}, 'abc/x/y', False, True),
            ({'': ['abc/**']}, 'abc', True, False),
            ({'': ['abc/**']}, 'xabc/x', False, False),
            ({'': ['a/**/b']}, 'a/b', False, True),
            ({'': ['a/**/b']}, 'a/x/b', False, True),
            ({'': ['a/**/b']}, 'a/x/y/b', False, True),
            ({'': ['a/**/b']}, 'x/a/b', False, False),
            ({'': ['a/**/b']}, 'a/b/c', False, True),
            ({'': ['logs/**', '!logs/keep/']}, 'logs/keep', True, False),
            ({'': ['logs/**', '!logs/keep/']}, 'logs/keep/a.txt', False, True),
            ({'': ['logs/**', '!logs/keep/']}, 'logs/other.txt', False, True),
            ({'': ['a**b']}, 'axxb', False, True),
            ({'': ['a**b']}, 'a/b', False, False),
            ({'': ['a**b']}, 'ab', False, True),
        ])

    def test_wildcards_and_sets(self):
        self.check([
            ({'': ['file?.txt']}, 'file1.txt', False, True),
            ({'': ['file?.txt']}, 'file10.txt', False, False),
            ({'': ['file?.txt']}, 'file.txt', False, False),
            ({'': ['file?.txt']}, 'd/fileA.txt', False, True),
            ({'': ['[abc]*.txt']}, 'a1.txt', False, True),
            ({'': ['[abc]*.txt']}, 'd1.txt', False, False),
            ({'': ['[abc]*.txt']}, 'c.txt', False, True),
            ({'': ['[!0-9]*.csv']}, 'x.csv', False, True),
            ({'': ['[!0-9]*.csv']}, '9x.csv', False, False),
            ({'': ['data[0-9][0-9]']}, 'data07', False, True),
            ({'': ['data[0-9][0-9]']}, 'data7', False, False),
            ({'': ['data[0-9][0-9]']}, 'data7x', False, False),
        ])

    def test_escapes_comments_and_spaces(self):
        self.check([
            ({'': ['\\#notes', '#comment']}, '#notes', False, True),
            ({'': ['\\#notes', '#comment']}, '#comment', False, False),
            ({'': ['\\!important']}, '!important', False, True),
            ({'': ['\\!important']}, 'important', False, False),
            ({'': ['name\\ ']}, 'name ', False, True),
            ({'': ['name\\ ']}, 'name', False, False),
            ({'': ['spaced   ']}, 'spaced', False, True),
            ({'': ['spaced   ']}, 'spaced   ', False, False),
            ({'': ['\\*.md']}, '*.md', False, True),
            ({'': ['\\*.md']}, 'a.md', False, False),
            ({'': ['', '# just a comment', '   ', '*.tmp']}, 'x.tmp', False, True),
            ({'': ['', '# just a comment', '   ', '*.tmp']}, 'x.tmpl', False, False),
        ])

    def test_case_sensitive(self):
        self.check([
            ({'': ['*.LOG']}, 'x.log', False, False),
            ({'': ['*.LOG']}, 'X.LOG', False, True),
        ])

    def test_negating_a_directory(self):
        self.check([
            ({'': ['build/', '!build/']}, 'build/x', False, False),
            ({'': ['build/', '!build/']}, 'build', True, False),
        ])

    def test_a_deeper_file_takes_precedence(self):
        self.check([
            ({'': ['*.log'], 'src': ['!keep.log']}, 'src/keep.log', False, False),
            ({'': ['*.log'], 'src': ['!keep.log']}, 'keep.log', False, True),
            ({'': ['*.log'], 'src': ['!keep.log']}, 'src/a.log', False, True),
            ({'': ['*.log'], 'src': ['!keep.log']}, 'src/x/keep.log', False, False),
            ({'': ['!*.txt'], 'docs': ['*.txt']}, 'docs/a.txt', False, True),
            ({'': ['!*.txt'], 'docs': ['*.txt']}, 'a.txt', False, False),
            ({'': ['!*.txt'], 'docs': ['*.txt']}, 'docs/sub/b.txt', False, True),
            ({'a': ['b/c'], '': ['!a/b/c']}, 'a/b/c', False, True),
            ({'': ['a/b/c'], 'a': ['!b/c']}, 'a/b/c', False, False),
            ({'a/b': ['*'], 'a': ['!b/keep']}, 'a/b/keep', False, True),
            ({'a/b': ['*'], 'a': ['!b/keep']}, 'a/b/other', False, True),
        ])

    def test_patterns_are_relative_to_their_file(self):
        self.check([
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'src/out', False, True),
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'out', False, False),
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'src/x/out', False, False),
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'src/gen/a.c', False, True),
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'gen/a.c', False, False),
            ({'': ['build/'], 'src': ['/out', 'gen/']}, 'src/x/gen/b.c', False, True),
            ({'src': ['sub/*.tmp']}, 'src/sub/a.tmp', False, True),
            ({'src': ['sub/*.tmp']}, 'sub/a.tmp', False, False),
            ({'src': ['sub/*.tmp']}, 'src/x/sub/a.tmp', False, False),
            ({'src': ['*.o'], 'lib': ['!*.o']}, 'src/a.o', False, True),
            ({'src': ['*.o'], 'lib': ['!*.o']}, 'lib/a.o', False, False),
            ({'src': ['*.o'], 'lib': ['!*.o']}, 'a.o', False, False),
            ({'src/app': ['/config.local']}, 'src/app/config.local', False, True),
            ({'src/app': ['/config.local']}, 'src/config.local', False, False),
            ({'src/app': ['/config.local']}, 'src/app/x/config.local', False, False),
            ({'src': ['**/tmp']}, 'src/tmp', False, True),
            ({'src': ['**/tmp']}, 'src/a/b/tmp', False, True),
            ({'src': ['**/tmp']}, 'tmp', False, False),
        ])

    def test_a_file_inside_an_ignored_directory_cant_rescue_anything(self):
        self.check([
            ({'': ['docs/'], 'docs': ['!keep.md']}, 'docs/keep.md', False, True),
            ({'': ['vendor/*'], 'vendor': ['!keep/'], 'vendor/keep': ['*.bak']}, 'vendor/keep/a.go', False, False),
            ({'': ['vendor/*'], 'vendor': ['!keep/'], 'vendor/keep': ['*.bak']}, 'vendor/keep/a.bak', False, True),
            ({'': ['vendor/*'], 'vendor': ['!keep/'], 'vendor/keep': ['*.bak']}, 'vendor/drop/a.go', False, True),
            ({'src': ['cache/'], 'src/cache': ['!*']}, 'src/cache/data', False, True),
        ])

    def test_a_files_patterns_dont_apply_to_its_own_directory(self):
        self.check([
            ({'src': ['src']}, 'src', True, False),
            ({'src': ['src']}, 'src/src', True, True),
            ({'src': ['src']}, 'src/a/src', False, True),
            ({'a': ['*']}, 'a', True, False),
            ({'a': ['*']}, 'a/x', False, True),
            ({'a': ['*']}, 'b/x', False, False),
        ])


if __name__ == "__main__":
    unittest.main()
