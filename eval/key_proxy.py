"""A proxy on the host that holds the API key, so Terminal-Bench's containers never do.

The adapter (jig_agent.py) gives jig in the container a token of this run instead of the key, and points
its --base-url at this proxy, which checks the token, puts the real key in its place and forwards the
request to the provider, streaming the reply back as it comes. In milestone 24 a model read
/proc/<pid>/environ as root in a container and printed the key into its log: with the proxy, what it can
read is a token that works only through this proxy, on this machine, while the run lasts.

It listens on 127.0.0.1 only: containers reach it through host.docker.internal (OrbStack and Docker
Desktop forward that to the host's loopback), and nothing else on the network can.
"""

from __future__ import annotations

import hmac
import http.client
import http.server
import secrets
import ssl
import threading
from urllib.parse import urlsplit

# Not forwarded either way: they describe one connection, not the request.
HOP_BY_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"}


class KeyProxy:
    """Forwards requests made with `token` to `upstream` (an origin, like https://api.deepseek.com) with `key`."""

    def __init__(self, upstream: str, key: str, token: str | None = None, timeout: float = 900):
        self.upstream = urlsplit(upstream)
        self.key = key
        self.token = token or f"jig-proxy-{secrets.token_hex(16)}"
        self.timeout = timeout
        proxy = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                proxy.forward(self)

            def do_GET(self) -> None:
                proxy.forward(self)

            def log_message(self, *args) -> None:  # the trials' logs say what happened
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def authorized(self, headers) -> bool:
        """The token, as the Anthropic SDK sends a key (x-api-key) or the OpenAI SDK does (a bearer token)."""
        given = headers.get("x-api-key") or (headers.get("authorization") or "").removeprefix("Bearer ").strip()
        return hmac.compare_digest(given.encode(), self.token.encode())

    def forward(self, handler: http.server.BaseHTTPRequestHandler) -> None:
        if not self.authorized(handler.headers):
            body = b'{"error": {"type": "authentication_error", "message": "not this run\'s token"}}'
            handler.send_response(401)
            handler.send_header("content-type", "application/json")
            handler.send_header("content-length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
            return
        length = int(handler.headers.get("content-length") or 0)
        body = handler.rfile.read(length) if length else None
        headers = {name: value for name, value in handler.headers.items() if name.lower() not in HOP_BY_HOP}
        # The key goes where the token was.
        if "x-api-key" in {name.lower() for name in headers}:
            headers = {name: value for name, value in headers.items() if name.lower() != "x-api-key"} | {"x-api-key": self.key}
        else:
            headers = {name: value for name, value in headers.items() if name.lower() != "authorization"} | {"authorization": f"Bearer {self.key}"}
        secure = self.upstream.scheme == "https"
        connection_type = http.client.HTTPSConnection if secure else http.client.HTTPConnection
        options = {"context": ssl.create_default_context()} if secure else {}
        upstream = connection_type(self.upstream.hostname, self.upstream.port, timeout=self.timeout, **options)
        try:
            path = self.upstream.path.rstrip("/") + handler.path
            try:
                upstream.request(handler.command, path, body=body, headers=headers)
                response = upstream.getresponse()
            except OSError as err:  # couldn't reach the provider: say so, as a gateway would
                message = f'{{"error": {{"type": "api_error", "message": "the key proxy could not reach {self.upstream.hostname}: {type(err).__name__}"}}}}'.encode()
                handler.send_response(502)
                handler.send_header("content-type", "application/json")
                handler.send_header("content-length", str(len(message)))
                handler.end_headers()
                handler.wfile.write(message)
                return
            handler.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in HOP_BY_HOP:
                    handler.send_header(name, value)
            # Streamed as it arrives (a reply is server-sent events), in chunks the client can read as they come.
            handler.send_header("transfer-encoding", "chunked")
            handler.end_headers()
            while chunk := response.read1(65536):
                handler.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                handler.wfile.flush()
            handler.wfile.write(b"0\r\n\r\n")
            handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # jig went away (interrupted, or out of time): nobody to answer
        finally:
            upstream.close()


# The providers' origins, by the model's name: what jig would call without a proxy.
UPSTREAMS = {"deepseek": "https://api.deepseek.com", "claude": "https://api.anthropic.com"}

_proxies: dict[tuple[str, str], KeyProxy] = {}
_lock = threading.Lock()


def proxy_for(upstream: str, key: str) -> KeyProxy:
    """One proxy for each upstream and key in this process (Harbor runs a job's trials in one), started on first use."""
    with _lock:
        if (upstream, key) not in _proxies:
            _proxies[(upstream, key)] = KeyProxy(upstream, key)
        return _proxies[(upstream, key)]
