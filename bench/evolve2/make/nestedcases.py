NESTED = {
    "test_a_deeper_file_takes_precedence": [
        ({"": ["*.log"], "src": ["!keep.log"]}, [("src/keep.log", False), ("keep.log", False), ("src/a.log", False), ("src/x/keep.log", False)]),
        ({"": ["!*.txt"], "docs": ["*.txt"]}, [("docs/a.txt", False), ("a.txt", False), ("docs/sub/b.txt", False)]),
        ({"a": ["b/c"], "": ["!a/b/c"]}, [("a/b/c", False)]),
        ({"": ["a/b/c"], "a": ["!b/c"]}, [("a/b/c", False)]),
        ({"a/b": ["*"], "a": ["!b/keep"]}, [("a/b/keep", False), ("a/b/other", False)]),
    ],
    "test_patterns_are_relative_to_their_file": [
        ({"": ["build/"], "src": ["/out", "gen/"]}, [("src/out", False), ("out", False), ("src/x/out", False), ("src/gen/a.c", False), ("gen/a.c", False), ("src/x/gen/b.c", False)]),
        ({"src": ["sub/*.tmp"]}, [("src/sub/a.tmp", False), ("sub/a.tmp", False), ("src/x/sub/a.tmp", False)]),
        ({"src": ["*.o"], "lib": ["!*.o"]}, [("src/a.o", False), ("lib/a.o", False), ("a.o", False)]),
        ({"src/app": ["/config.local"]}, [("src/app/config.local", False), ("src/config.local", False), ("src/app/x/config.local", False)]),
        ({"src": ["**/tmp"]}, [("src/tmp", False), ("src/a/b/tmp", False), ("tmp", False)]),
    ],
    "test_a_file_inside_an_ignored_directory_cant_rescue_anything": [
        ({"": ["docs/"], "docs": ["!keep.md"]}, [("docs/keep.md", False)]),
        ({"": ["vendor/*"], "vendor": ["!keep/"], "vendor/keep": ["*.bak"]}, [("vendor/keep/a.go", False), ("vendor/keep/a.bak", False), ("vendor/drop/a.go", False)]),
        ({"src": ["cache/"], "src/cache": ["!*"]}, [("src/cache/data", False)]),
    ],
    "test_a_files_patterns_dont_apply_to_its_own_directory": [
        ({"src": ["src"]}, [("src", True), ("src/src", True), ("src/a/src", False)]),
        ({"a": ["*"]}, [("a", True), ("a/x", False), ("b/x", False)]),
    ],
}
