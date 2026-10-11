import random, re
from maketask import task

OLD = re.compile(r"^([a-zA-Z0-9]+[-_. ]?)+\.(txt|csv|json|png|jpg)$")
rng = random.Random(3)
alphabet = ["a", "B", "7", "-", "_", ".", " ", "txt", "csv", ".png", ".jpg", "!", "\n", "é", "json", "..", "Z9"]
corpus = sorted({"".join(rng.choice(alphabet) for _ in range(rng.randrange(1, 7))) for _ in range(400)})
corpus += ["a.txt", "a.txt\n", "a..txt", "a__b.txt", "-a.txt", ".txt", "a.TXT", "my report.csv", "a.csv.txt", "a.png ", "data_2024-03.json",
           "x y z.jpg", "a .txt", "a. .txt", "a.b.c.png", "photo.jpeg", "über.txt", "a\n.txt", "a.txt\n\n", "", "a", "1.jpg", "a--b.csv", "a-_b.csv"]
CORPUS = [(name, OLD.match(name) is not None) for name in corpus]
SLOW = ["scan 20240311 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011.pdf", "a" * 60 + "!", "0" * 50 + ".pdf", "x-" * 30 + "x..exe", "Report 2024 " * 6 + ".docx", "IMG" + "1234567890" * 5 + ".jpg.bak"]

NAMES = '''
    import re

    # A name: letters and digits, with single separators between them (and maybe one before the
    # extension), then an extension we accept.
    NAME = re.compile(r"^([a-zA-Z0-9]+[-_. ]?)+\\.(txt|csv|json|png|jpg)$")


    def is_valid_name(name):
        return NAME.match(name) is not None
'''
NAMES_FIXED = '''
    import re

    # A name: letters and digits, with single separators between them (and maybe one before the
    # extension), then an extension we accept. Each repetition starts with its separator, so there is
    # only one way to match a name, and a name that doesn't match fails at once.
    NAME = re.compile(r"^[a-zA-Z0-9]+(?:[-_. ][a-zA-Z0-9]+)*[-_. ]?\\.(txt|csv|json|png|jpg)$")


    def is_valid_name(name):
        return NAME.match(name) is not None
'''
STORE = '''
    from dataclasses import dataclass


    @dataclass(frozen=True)
    class Upload:
        name: str
        size: int
        owner: str


    class Store:
        def __init__(self):
            self.uploads = []

        def add(self, upload):
            self.uploads.append(upload)

        def names(self):
            """Every file name uploaded, once each, in order."""
            NAMES_BODY

        def by_owner(self, owner):
            return [upload for upload in self.uploads if upload.owner == owner]

        def total_size(self):
            return sum(upload.size for upload in self.uploads)
'''
SLOW_NAMES = '''seen = []
            for upload in self.uploads:
                if upload.name not in seen:
                    seen.append(upload.name)
            return sorted(seen)'''
FAST_NAMES = '''return sorted({upload.name for upload in self.uploads})'''
HANDLER = '''
    from .config import MAX_SIZE
    from .errors import UploadError
    from .names import is_valid_name
    from .sizes import check_size
    from .store import Upload


    def handle_upload(store, request):
        """Stores an upload described by a request {"name", "size", "owner"}, or says why not."""
        try:
            missing = [key for key in ("name", "size", "owner") if key not in request]
            if missing:
                raise UploadError(f"missing {', '.join(missing)}")
            if not is_valid_name(request["name"]):
                raise UploadError(f"invalid name: {request['name']!r}")
            check_size(request["size"])
        except UploadError as error:
            return {"status": "rejected", "reason": str(error)}
        store.add(Upload(request["name"], request["size"], request["owner"]))
        return {"status": "ok", "limit": MAX_SIZE}
'''
files = {
    "ISSUE.md": '''
        # The upload server hangs

        1. Every so often the server stops responding for minutes. We traced it to some uploads with long
           names, like `scan 20240311 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011.pdf` from the
           office scanner. A name like that must be rejected at once (pdf isn't allowed anyway). Don't
           change which names are accepted: every name accepted today must still be accepted, and every
           name rejected today must still be rejected.

        2. The page that lists the uploaded files' names gets slower every week, and with this month's
           100,000 uploads it takes minutes. It must show the same list, within a second or two.
    ''',
    "uploads/__init__.py": '"""Taking file uploads."""\n',
    "uploads/config.py": '''
        MAX_SIZE = 10 * 1024 * 1024  # bytes
    ''',
    "uploads/errors.py": '''
        class UploadError(Exception):
            """An upload we won't take, and why."""
    ''',
    "uploads/sizes.py": '''
        from .config import MAX_SIZE
        from .errors import UploadError


        def check_size(size):
            if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
                raise UploadError(f"invalid size: {size!r}")
            if size > MAX_SIZE:
                raise UploadError(f"too large: {size} bytes (at most {MAX_SIZE})")
    ''',
    "uploads/names.py": NAMES,
    "uploads/store.py": STORE.replace("NAMES_BODY", SLOW_NAMES),
    "uploads/handler.py": HANDLER,
    "tests/__init__.py": "",
    "tests/test_uploads.py": '''
        import unittest

        from uploads.handler import handle_upload
        from uploads.store import Store


        class TestUploads(unittest.TestCase):
            def test_accepted_and_listed(self):
                store = Store()
                self.assertEqual(handle_upload(store, {"name": "notes.txt", "size": 10, "owner": "ada"})["status"], "ok")
                self.assertEqual(handle_upload(store, {"name": "notes.txt", "size": 20, "owner": "bob"})["status"], "ok")
                self.assertEqual(store.names(), ["notes.txt"])

            def test_rejected(self):
                store = Store()
                result = handle_upload(store, {"name": "virus.exe", "size": 10, "owner": "eve"})
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(handle_upload(store, {"name": "big.png", "size": 10**9, "owner": "eve"})["status"], "rejected")
                self.assertEqual(store.names(), [])


        if __name__ == "__main__":
            unittest.main()
    ''',
}
HIDDEN = f'''
import os
import subprocess
import sys
import unittest

from uploads.handler import handle_upload
from uploads.names import is_valid_name
from uploads.store import Store, Upload

CORPUS = {CORPUS!r}
SLOW = {SLOW!r}


def run_in_time(code, seconds):
    """Runs Python code in the project, in a process of its own, and fails if it takes longer."""
    try:
        done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=seconds, env={{**os.environ, "PYTHONPATH": "."}})
    except subprocess.TimeoutExpired:
        raise AssertionError(f"took more than {{seconds}} seconds") from None
    if done.returncode:
        raise AssertionError(done.stderr[-2000:])
    return done.stdout.strip()


class TestIssue(unittest.TestCase):
    def test_long_names_are_rejected_at_once(self):
        for name in SLOW:
            with self.subTest(name=name):
                self.assertEqual(run_in_time(f"from uploads.names import is_valid_name; print(is_valid_name({{name!r}}))", 5), "False")

    def test_the_handler_rejects_them_at_once(self):
        code = (
            "from uploads.handler import handle_upload; from uploads.store import Store; "
            f"print(handle_upload(Store(), {{{{'name': {{SLOW[0]!r}}, 'size': 10, 'owner': 'scanner'}}}})['status'])"
        )
        self.assertEqual(run_in_time(code, 5), "rejected")

    def test_the_same_names_are_accepted(self):
        for name, accepted in CORPUS:
            with self.subTest(name=name):
                self.assertEqual(is_valid_name(name), accepted)

    def test_listing_100000_uploads_is_quick(self):
        code = (
            "from uploads.store import Store, Upload; s = Store(); "
            "[s.add(Upload(f'file{{i % 60000:05d}}.txt', 1, 'x')) for i in range(100000)]; "
            "names = s.names(); print(len(names), names[0], names[-1])"
        )
        self.assertEqual(run_in_time(code, 10), "60000 file00000.txt file59999.txt")

    def test_the_list_is_the_same(self):
        store = Store()
        for name in ["b.txt", "a.csv", "b.txt", "C.png", "a.csv", "a b.txt"]:
            store.add(Upload(name, 1, "x"))
        self.assertEqual(store.names(), ["C.png", "a b.txt", "a.csv", "b.txt"])
        self.assertEqual(Store().names(), [])


class TestUnchanged(unittest.TestCase):
    def test_uploads(self):
        store = Store()
        self.assertEqual(handle_upload(store, {{"name": "a.txt", "size": 5, "owner": "ada"}}), {{"status": "ok", "limit": 10 * 1024 * 1024}})
        self.assertEqual(handle_upload(store, {{"name": "b.txt", "size": 7, "owner": "bob"}})["status"], "ok")
        self.assertEqual(handle_upload(store, {{"name": "c.txt", "owner": "bob"}}), {{"status": "rejected", "reason": "missing size"}})
        self.assertEqual(handle_upload(store, {{"name": "c.txt", "size": 0, "owner": "bob"}})["status"], "rejected")
        self.assertEqual(handle_upload(store, {{"name": "c.exe", "size": 1, "owner": "bob"}})["reason"], "invalid name: 'c.exe'")
        self.assertEqual((store.total_size(), [u.name for u in store.by_owner("bob")]), (12, ["b.txt"]))


if __name__ == "__main__":
    unittest.main()
'''
task(
    "upload-hang",
    "Fix the problems reported in ISSUE.md, without changing anything else about how the uploads package behaves.",
    ["python", "bugs", "performance", "many files"],
    files,
    HIDDEN,
    {"uploads/names.py": NAMES_FIXED, "uploads/store.py": STORE.replace("NAMES_BODY", FAST_NAMES)},
)
