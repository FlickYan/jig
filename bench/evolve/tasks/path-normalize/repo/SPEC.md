# normalize(path) -> str

Normalizes the path part of a URL, as RFC 3986 section 6 describes.

1. Percent-encoded unreserved characters are decoded: letters, digits, `-`, `.`, `_` and `~`
   (`%7Euser` becomes `~user`, `%41` becomes `A`). Every other percent-encoding stays encoded, with
   its hex digits in upper case: `%2f` becomes `%2F`. An encoded slash is never decoded, so it stays
   part of its segment.
2. Then dot segments are removed, by RFC 3986's remove_dot_segments: `.` segments go, and `..` takes
   out the segment before it: `/a/b/../c/./d` is `/a/c/d`. A `..` above the root is dropped:
   `/../a` is `/a`. Since decoding comes first, `/a/%2E%2E/b` is `/b`.
3. Runs of slashes become one slash: `//a///b` is `/a/b`.
4. A trailing slash stays: `/a/b/` is `/a/b/`. A path that ends in `/.` or `/..` (before or after
   decoding) ends in a slash once normalized: `/a/b/..` is `/a/`, and `/a/.` is `/a/`.
5. The result always starts with `/`: `a/b` is `/a/b`, and the empty path is `/`.
6. A `%` that isn't followed by two hex digits raises `ValueError`.
