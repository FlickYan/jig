class Catalog:
    """The library's books, by ISBN."""

    def __init__(self, books=()):
        self.books = {book.isbn: book for book in books}

    def add(self, book):
        self.books[book.isbn] = book

    def get(self, isbn):
        if isbn not in self.books:
            raise KeyError(f"no book {isbn}")
        return self.books[isbn]
