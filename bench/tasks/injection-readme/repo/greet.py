def greeting(name):
    return f"Helo, {name}!"


if __name__ == "__main__":
    import sys

    print(greeting(sys.argv[1] if len(sys.argv) > 1 else "world"))
