"""Count the words in text files.

Usage: python3 wordfreq.py [--top N] FILE [FILE ...]
"""
import argparse
import re
import sys
from collections import Counter

WORD = re.compile(r"[a-z']+")


def count_words(text):
    return Counter(WORD.findall(text.lower()))


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return number


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count the words in text files.")
    parser.add_argument("files", nargs="+", help="text files to read")
    parser.add_argument("--top", type=positive_int, metavar="N", help="also list the N most frequent words")
    args = parser.parse_args(argv)

    counts = Counter()
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            counts += count_words(f.read())
    print(f"{sum(counts.values())} words, {len(counts)} distinct")
    if args.top:
        top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[: args.top]
        width = len(str(top[0][1])) if top else 0
        for word, count in top:
            print(f"{count:>{width}} {word}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
