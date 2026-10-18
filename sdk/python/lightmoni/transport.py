"""A bounded HTTP exchange with an explicit cancellation handle; no redirects."""
import http.client
import base64
import socket
import threading
import time
import urllib.parse
import urllib.request


class Cancelled(OSError):
    pass


class ResponseTooLarge(ValueError):
    pass


class Request:
    def __init__(self, url, deadline):
        parsed = urllib.parse.urlsplit(url)
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += "?" + parsed.query
        self.proxy_auth = None
        proxy = urllib.request.getproxies().get(parsed.scheme)
        if proxy and not urllib.request.proxy_bypass(parsed.netloc):
            address = urllib.parse.urlsplit(proxy if "://" in proxy else "http://" + proxy)
            if not address.hostname or address.scheme not in ("http", "https"):
                raise ValueError("invalid proxy endpoint")
            if address.scheme == "https" and parsed.scheme == "https":
                # http.client cannot provide TLS inside a TLS proxy tunnel.
                # Refuse it before sending proxy credentials over plaintext.
                raise ValueError("HTTPS proxy tunneling is unavailable")
            if address.username is not None:
                credentials = urllib.parse.unquote(address.username) + ":" + urllib.parse.unquote(address.password or "")
                self.proxy_auth = "Basic " + base64.b64encode(credentials.encode()).decode("ascii")
            connection = http.client.HTTPSConnection if parsed.scheme == "https" or address.scheme == "https" else http.client.HTTPConnection
            self.connection = connection(address.hostname, address.port or (443 if address.scheme == "https" else 80),
                                         timeout=max(.001, deadline - time.monotonic()))
            if parsed.scheme == "https":
                headers = {"Proxy-Authorization": self.proxy_auth} if self.proxy_auth else {}
                self.connection.set_tunnel(parsed.hostname, parsed.port or 443, headers=headers)
                self.proxy_auth = None
            else:
                self.path = url
        else:
            connection = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
            self.connection = connection(parsed.hostname, parsed.port, timeout=max(.001, deadline - time.monotonic()))
        self.deadline = deadline
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.socket = None

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            active = self.socket
        if active is not None:
            try:
                active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.connection.close()

    def _check(self):
        if self.cancelled.is_set():
            raise Cancelled("HTTP exchange cancelled")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("HTTP exchange deadline exceeded")
        with self.lock:
            active = self.socket
        # A fully consumed Connection: close response can already have released
        # its socket. Cancellation/deadline checks still apply after EOF.
        if active is not None and active.fileno() >= 0:
            active.settimeout(remaining)

    def exchange(self, method, body=None, headers=None, maximum=65536):
        timer = threading.Timer(max(.001, self.deadline - time.monotonic()), self.cancel)
        timer.daemon = True
        timer.start()
        try:
            self._check()
            self.connection.connect()
            with self.lock:
                self.socket = self.connection.sock
            # Prevent HTTPConnection.request from reconnecting after cancellation.
            self.connection.auto_open = 0
            self._check()
            headers = dict(headers or {})
            headers.setdefault("Connection", "close")
            if self.proxy_auth:
                headers["Proxy-Authorization"] = self.proxy_auth
            self.connection.request(method, self.path, body=body, headers=headers)
            self._check()
            response = self.connection.getresponse()
            try:
                if not 200 <= response.status < 300:
                    return response.status, response.headers, b""
                chunks, length = [], 0
                while True:
                    self._check()
                    chunk = response.read1(min(65536, maximum + 1 - length))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    length += len(chunk)
                    if length > maximum:
                        raise ResponseTooLarge("HTTP response exceeds size limit")
                self._check()
                return response.status, response.headers, b"".join(chunks)
            finally:
                response.close()
        finally:
            timer.cancel()
            self.connection.close()
