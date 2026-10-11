from .config import MAX_SIZE
from .errors import UploadError


def check_size(size):
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise UploadError(f"invalid size: {size!r}")
    if size > MAX_SIZE:
        raise UploadError(f"too large: {size} bytes (at most {MAX_SIZE})")
