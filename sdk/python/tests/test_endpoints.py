import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from lightmoni import Client
from lightmoni.endpoints import CenterEndpoints


class CenterEndpointTests(unittest.TestCase):
    def test_authenticated_refresh_recovers_only_verified_entrance(self):
        endpoint = CenterEndpoints('http://public')
        state = {'identity': 'same', 'denied': False}
        calls = []
        def read(url, key, deadline):
            calls.append((url, key))
            if url.endswith('center-identity'):
                self.assertEqual(key, '')
                return {'center_id': state['identity']}
            if state['denied']:
                raise PermissionError('center discovery access denied')
            return dict(version=1, center_id='same', revision='unchanged', endpoints=[dict(url='http://public', scope='public')])
        endpoint._json = read
        self.assertEqual(endpoint.resolve('secret', time.monotonic()+3), 'http://public')
        endpoint.failure('http://public')
        self.assertEqual(endpoint.resolve('secret', time.monotonic()+3, force=True), 'http://public')
        self.assertNotIn('http://public', endpoint.failed)
        endpoint.failure('http://public')
        state['denied'] = True
        with self.assertRaises(PermissionError):
            endpoint.resolve('secret', time.monotonic()+3, force=True)
        self.assertIn('http://public', endpoint.failed)
        state['denied'] = False
        state['identity'] = 'foreign'
        before = len([key for _, key in calls if key])
        with self.assertRaises(OSError):
            endpoint.resolve('secret', time.monotonic()+3, force=True)
        self.assertEqual(len([key for _, key in calls if key]), before)

    def test_internal_public_and_changed_port(self):
        state = dict(public="", internal="", revision="one", foreign=False)
        seen, secrets = [], []
        servers = []
        def entrance(name):
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_GET(self):
                    if self.path == "/v1/center-identity":
                        self.server.test.assertIsNone(self.headers.get("Authorization"))
                        value = {"center_id": "other" if name == "foreign" else "same"}
                    else:
                        secrets.append((name, self.headers.get("Authorization")))
                        value = dict(version=1, center_id="same", revision=state["revision"], endpoints=[
                            dict(url=state["internal"], scope="internal"), dict(url=state["public"], scope="public")])
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps(value).encode())
                def do_POST(self):
                    self.rfile.read(int(self.headers["Content-Length"]))
                    seen.append(name)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.test = self
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
            return server, "http://127.0.0.1:" + str(server.server_port)
        _, state["public"] = entrance("public")
        internal, state["internal"] = entrance("internal")
        client = Client("routing", "business", endpoint=state["public"], key="secret", self_telemetry=False, remote_config=False)
        try:
            client.refresh_endpoints()
            client.log("info", "one")
            client.flush(timeout=3)
            self.assertEqual(seen[-1], "internal")
            internal.shutdown()
            internal.server_close()
            client.log("info", "two")
            client.flush(timeout=3)
            self.assertEqual(seen[-1], "public")
            _, state["internal"] = entrance("replacement")
            state["revision"] = "two"
            client.refresh_endpoints()
            client.log("info", "three")
            client.flush(timeout=3)
            self.assertEqual(seen[-1], "replacement")
            _, state["internal"] = entrance("foreign")
            state["revision"] = "three"
            client.refresh_endpoints()
            client.log("info", "four")
            client.flush(timeout=3)
            self.assertEqual(seen[-1], "public")
            self.assertFalse(any(name == "foreign" and secret for name, secret in secrets))
        finally:
            client.shutdown(timeout=2)
            for server in servers:
                server.shutdown()
                server.server_close()
