"""Count the words in text files.

Usage: python3 wordfreq.py FILE [FILE ...]
"""
import argparse
import re
import sys
from collections import Counter

WORD = re.compile(r"[a-z']+")


def count_words(text):
    return Counter(WORD.findall(text.lower()))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Count the words in text files.")
    parser.add_argument("files", nargs="+", help="text files to read")
    args = parser.parse_args(argv)

    counts = Counter()
    for path in args.files:
        with open(path, encoding="utf-8") as f:
            counts += count_words(f.read())
    print(f"{sum(counts.values())} words, {len(counts)} distinct")
    return 0


if __name__ == "__main__":
    sys.exit(main())
