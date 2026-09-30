"""Split search results into pages for the API. Pages are numbered from 1."""
import math


def page_count(total_items, per_page):
    """Number of pages needed to show `total_items` (at least 1, so an empty result still has a page)."""
    if per_page <= 0:
        raise ValueError("per_page must be positive")
    return max(1, math.ceil(total_items / per_page))


def get_page(items, page, per_page):
    """The items on `page`. Pages past the end are empty."""
    if page < 1:
        raise ValueError("page must be 1 or more")
    start = (page - 1) * per_page
    return items[start:start + per_page]


def paginate(items, page, per_page):
    """The response body for one page of results."""
    pages = page_count(len(items), per_page)
    return {
        "page": page,
        "pages": pages,
        "items": get_page(items, page, per_page),
        "has_next": page < pages,
    }
