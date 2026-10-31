"""Center address discovery; probes never carry SDK credentials."""
import json
import ssl
import threading
import time
import urllib.parse
from .transport import Request


def center_url(value):
    if not isinstance(value, str) or any(c in value for c in "?#\\ \r\n\t"):
        raise ValueError("invalid center endpoint")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("invalid center endpoint")
    if parsed.port == 0:
        raise ValueError("invalid center port")
    return value.rstrip("/")


class CenterEndpoints:
    def __init__(self, bootstrap):
        self.bootstrap = center_url(bootstrap)
        self.selected, self.manifest = "", None
        self.expires, self.selected_until = 0, 0
        self.failed, self.lock = {}, threading.Lock()
        self.pending, self.pending_lock = {}, threading.Lock()

    @staticmethod
    def _json(url, key, deadline):
        headers = {"Authorization": "Bearer " + key} if key else {}
        status, _, raw = Request(url, min(deadline, time.monotonic() + 1)).exchange("GET", headers=headers)
        if status in (401, 403):
            raise PermissionError("center discovery access denied")
        if status != 200:
            raise ValueError("center discovery unsupported or unavailable")
        return json.loads(raw)

    def resolve(self, key, deadline, force=False):
        if not self.lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise TimeoutError("center discovery deadline exceeded")
        try:
            now = time.monotonic()
            verified = ""
            with self.pending_lock:
                if self.pending:
                    self.failed.update(self.pending)
                    self.pending.clear()
                    self.selected_until = 0
            if force:
                self.expires = self.selected_until = 0
            if now < self.selected_until and self.selected:
                return self.selected
            if now >= self.expires:
                self.expires = now + 30
                for source in dict.fromkeys(filter(None, [self.selected, self.bootstrap] + ([e["url"] for e in self.manifest["endpoints"] if e["scope"]=="public"] if self.manifest else []))):
                    try:
                        if self.manifest and self._json(source + "/v1/center-identity", "", deadline).get("center_id") != self.manifest["center_id"]:
                            raise ValueError("center identity mismatch")
                        raw = self._json(source + "/v1/center-endpoints", key, deadline)
                        if (not isinstance(raw, dict) or type(raw.get("version")) is not int or raw.get("version") != 1 or not isinstance(raw.get("center_id"), str)
                                or not 1 <= len(raw["center_id"]) <= 128 or not isinstance(raw.get("revision"), str)
                                or not raw["revision"] or not isinstance(raw.get("endpoints"), list) or not 1 <= len(raw["endpoints"]) <= 20):
                            raise ValueError("invalid center manifest")
                        if self.manifest and raw["center_id"] != self.manifest["center_id"]:
                            raise ValueError("center identity mismatch")
                        endpoints = [{"url": center_url(e["url"]), "scope": e["scope"]} for e in raw["endpoints"]]
                        if (any(e["scope"] not in ("internal", "public") for e in endpoints)
                                or not any(e["scope"] == "public" for e in endpoints)):
                            raise ValueError("invalid center endpoint scope")
                        if not self.manifest or raw["revision"] != self.manifest["revision"]:
                            self.failed.clear()
                        self.manifest = dict(raw, endpoints=endpoints)
                        verified = source
                        break
                    except PermissionError:
                        raise
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
            if not self.manifest:
                self.selected, self.selected_until = self.bootstrap, self.expires
                return self.selected
            candidates = sorted(self.manifest["endpoints"], key=lambda e: e["scope"] == "public")
            if not any(e["url"] == self.bootstrap for e in candidates):
                candidates.append({"url": self.bootstrap, "scope": "public"})
            candidates.sort(key=lambda e: (e["scope"] == "public", e["url"] not in (verified,self.bootstrap)))
            probe_deadline = min(deadline, time.monotonic() + 3)
            for endpoint in candidates:
                url = endpoint["url"]
                if now < self.failed.get(url, 0) or (endpoint["scope"] == "internal" and time.monotonic() >= probe_deadline):
                    continue
                if url == verified:
                    self.selected, self.selected_until = url, self.expires
                    return url
                if time.monotonic() >= deadline:
                    break
                try:
                    identity = self._json(url + "/v1/center-identity", "", deadline)
                    if identity.get("center_id") != self.manifest["center_id"]:
                        raise ValueError("center identity mismatch")
                    self.selected, self.selected_until = url, self.expires
                    return url
                except (OSError, ValueError, TypeError, AttributeError):
                    if time.monotonic() < deadline:
                        self.failed[url] = now + 30
            raise OSError("no verified center endpoint is reachable")
        finally:
            self.lock.release()

    def failure(self, endpoint):
        with self.pending_lock:
            self.pending[endpoint] = time.monotonic() + 30
