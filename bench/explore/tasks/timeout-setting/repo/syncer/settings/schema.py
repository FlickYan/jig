REGIONS = ("eu", "us", "apac")

# name: (type, check, what a good value is)
SCHEMA = {
    "retries": (int, lambda value: value >= 0, "a whole number, 0 or more"),
    "region": (str, lambda value: value in REGIONS, f"one of {', '.join(REGIONS)}"),
    "page_size": (int, lambda value: 1 <= value <= 500, "a whole number from 1 to 500"),
}
