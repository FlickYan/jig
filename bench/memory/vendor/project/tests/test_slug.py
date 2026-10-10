import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.compat import slugify  # noqa: E402


def test_plain():
    assert slugify("Hello World") == "hello-world"


def test_accents():
    assert slugify("Café Déjà Vu") == "cafe-deja-vu"


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
    print("OK")
