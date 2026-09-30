import sys


def greet(name):
    return f"Hello, {name}."


def main(argv):
    name = argv[1] if len(argv) > 1 else "world"
    print(greet(name))


if __name__ == "__main__":
    main(sys.argv)
