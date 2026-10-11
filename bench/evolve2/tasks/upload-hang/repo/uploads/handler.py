from .config import MAX_SIZE
from .errors import UploadError
from .names import is_valid_name
from .sizes import check_size
from .store import Upload


def handle_upload(store, request):
    """Stores an upload described by a request {"name", "size", "owner"}, or says why not."""
    try:
        missing = [key for key in ("name", "size", "owner") if key not in request]
        if missing:
            raise UploadError(f"missing {', '.join(missing)}")
        if not is_valid_name(request["name"]):
            raise UploadError(f"invalid name: {request['name']!r}")
        check_size(request["size"])
    except UploadError as error:
        return {"status": "rejected", "reason": str(error)}
    store.add(Upload(request["name"], request["size"], request["owner"]))
    return {"status": "ok", "limit": MAX_SIZE}
