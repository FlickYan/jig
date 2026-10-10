from pagination import page


def test_first_page():
    assert page(list(range(10)), 1, 3) == [0, 1, 2]


def test_last_page():
    assert page(list(range(10)), 4, 3) == [9]


if __name__ == "__main__":
    for name, test in list(globals().items()):
        if name.startswith("test_"):
            test()
    print("OK")
