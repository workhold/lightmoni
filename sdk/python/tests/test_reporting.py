"""Public reporting contract exercised through real local HTTP receivers."""
import collections
import copy
import json
import os
import select
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from lightmoni import Client


def condition(field, *values):
    return {"field": field, "operator": "in", "values": list(values)}


def rule(name="all", rate=1, conditions=None):
    return {"name": name, "rate": rate, "conditions": [] if conditions is None else conditions}


def snapshot(revision="v1", policies=None, disabled=None):
    return {"revision": revision, "log_sampling": policies or {}, "disable_rules": disabled or []}


def attributes(record):
    result = {}
    for item in record.get("attributes", []):
        value = item["value"]
        for key, parser in (("stringValue", str), ("boolValue", bool), ("intValue", int), ("doubleValue", float)):
            if key in value:
                result[item["key"]] = parser(value[key])
                break
    return result


class Receiver:
    """Configurable response callbacks run without holding the observation lock."""
    def __init__(self, tls_context=None, tunnel_to=None):
        self.lock = threading.Lock()
        self.requests = []
        self.config = snapshot()
        self.get_action = None
        self.post_action = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, status, body, headers=None):
                if not isinstance(body, bytes):
                    body = json.dumps(body, allow_nan=False).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    for key, value in (headers or {}).items():
                        self.send_header(key, value)
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                with owner.lock:
                    owner.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
                    action, config = owner.get_action, copy.deepcopy(owner.config)
                if action:
                    response = action(self)
                    if response is None:
                        return
                    status, body, headers = response
                else:
                    status, body, headers = 200, config, {}
                self.respond(status, body, headers)

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                request = {"method": "POST", "path": self.path, "headers": dict(self.headers), "body": body}
                with owner.lock:
                    owner.requests.append(request)
                    action = owner.post_action
                status, response, headers = action(request) if action else (200, {}, {})
                self.respond(status, response, headers)

            def do_CONNECT(self):
                with owner.lock:
                    owner.requests.append({"method": "CONNECT", "path": self.path, "headers": dict(self.headers)})
                if tunnel_to is None:
                    self.respond(405, {})
                    return
                # Forward only to the fixed local fixture, never the supplied
                # CONNECT hostname. No test can relay to an external host.
                try:
                    with socket.create_connection(tunnel_to, timeout=2) as destination:
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.flush()
                        peers = (self.connection, destination)
                        while True:
                            ready, _, _ = select.select(peers, [], [], 2)
                            if not ready:
                                return
                            for source in ready:
                                data = source.recv(65536)
                                if not data:
                                    return
                                target = destination if source is self.connection else self.connection
                                target.sendall(data)
                except OSError:
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        if tls_context is not None:
            self.server.socket = tls_context.wrap_socket(self.server.socket, server_side=True)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.url = ("https://localhost:%d" if tls_context is not None else "http://127.0.0.1:%d") % self.server.server_port

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(1)

    def observed(self, method=None):
        with self.lock:
            return [dict(request) for request in self.requests if method is None or request["method"] == method]

    def records(self, signal, table=None):
        resource, scope, field = {
            "logs": ("resourceLogs", "scopeLogs", "logRecords"),
            "metrics": ("resourceMetrics", "scopeMetrics", "metrics"),
            "traces": ("resourceSpans", "scopeSpans", "spans"),
        }[signal]
        rows = []
        for request in self.observed("POST"):
            if request["path"] != "/v1/" + signal or table is not None and request["headers"]["X-Lightmoni-Table"] != table:
                continue
            for group in json.loads(request["body"])[resource]:
                for batch in group[scope]:
                    rows.extend(batch[field])
        return rows


class ReportingTests(unittest.TestCase):
    def setUp(self):
        # Every receiver is local: inherited developer/system proxy credentials
        # must never become part of a test request or assertion failure.
        environment = mock.patch.dict(os.environ, {
            "http_proxy": "", "https_proxy": "", "all_proxy": "",
            "HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
            "no_proxy": "*", "NO_PROXY": "*",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.receiver = Receiver()
        self.addCleanup(self.receiver.close)

    def client(self, **options):
        defaults = dict(endpoint=self.receiver.url, self_telemetry=False, remote_config=False, instance_id="test-instance")
        defaults.update(options)
        client = Client("reporting-test", "web", **defaults)
        def close():
            try:
                client.shutdown(timeout=.3)
            except (OSError, RuntimeError):
                pass
        self.addCleanup(close)
        return client

    def test_qa_vip_maximum_exclusion_and_controlled_counters(self):
        policy = {
            "key": "attr:uid",
            "rules": [rule("click", .1, [condition("attr:event", "click")]),
                      rule("QA", 1, [condition("attr:uid", "qa")]),
                      rule("VIP", 1, [condition("attr:vip", True)])],
            "exclude": [{"name": "blocked UID", "conditions": [condition("attr:uid", "blocked")]}],
        }
        client = self.client(log_sampling={"web": policy})
        client.log("info", "qa", {"uid": "qa", "event": "click", "lightmoni.sampling.rate": .01, "lightmoni.sampling.rule": "caller"})
        client.log("info", "vip", {"uid": "vip", "vip": True, "event": "click"})
        client.log("error", "blocked", {"uid": "blocked", "vip": True})
        client.log("fatal", "unmatched", {"uid": "ordinary"})
        client.log("info", "string is not bool", {"vip": "true"})
        client.flush()
        rows = self.receiver.records("logs")
        self.assertEqual([row["body"]["stringValue"] for row in rows], ["qa", "vip"])
        for row, name in zip(rows, ("QA", "VIP")):
            attr = attributes(row)
            self.assertEqual(attr["lightmoni.sampling.rate"], 1)
            self.assertEqual(attr["lightmoni.sampling.weight"], 1)
            self.assertEqual(attr["lightmoni.sampling.rule"], name)
        stats = client.stats()
        self.assertEqual(stats["excluded_logs"], 1)
        self.assertEqual(stats["unmatched_logs"], 2)
        self.assertEqual(stats["dropped_records"], 0)
        self.assertEqual(stats["last_error"], "")

    def wait_for(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(.01)
        self.fail("condition did not become true before deadline")

    def background(self, callback):
        outcomes = []
        def run():
            try:
                callback()
                outcomes.append(None)
            except Exception as error:
                outcomes.append(error)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread, outcomes

    def test_strict_value_types_and_all_conditions(self):
        policy = {"rules": [
            rule("number", 1, [condition("attr:uid", 42.0), {"field": "attr:marker", "operator": "exists"}]),
            rule("bool", 1, [condition("attr:uid", True)]),
            rule("string", 1, [condition("attr:uid", "42")]),
        ]}
        client = self.client(log_sampling={"web": policy})
        for body, attrs in (("int", {"uid": 42, "marker": False}), ("float", {"uid": 42.0, "marker": ""}),
                            ("bool", {"uid": True}), ("string", {"uid": "42"}),
                            ("one is not bool", {"uid": 1}), ("missing condition", {"uid": 42})):
            client.log("info", body, attrs)
        client.flush()
        self.assertEqual([row["body"]["stringValue"] for row in self.receiver.records("logs")], ["int", "float", "bool", "string"])
        self.assertEqual(client.stats()["unmatched_logs"], 2)

    def test_fixed_cross_language_vectors_and_stable_uid_cohort(self):
        # Verified against sdk/typescript/dist/src/sampling.js sampleLog on 2026-10-14;
        # Go's existing LogSamplingPolicy.decide uses the same wire algorithm.
        vectors = [("0", False), ("1", False), ("2", False), ("42", False), ("100", True),
                   ("测试", True), ("vip-user", False), (True, False), (False, False), (0, True),
                   (1, False), (42, True), (1.5, True), (1e-7, False), ("9007199254740993", True),
                   (-0.0, True), (-1.25, True)]
        policy = {"key": "attr:uid", "rules": [rule("cohort", .5)]}
        client = self.client(log_sampling={"web": policy})
        for index, (value, _) in enumerate(vectors):
            client.log("info", str(index), {"uid": value})
        client.flush()
        self.assertEqual([int(row["body"]["stringValue"]) for row in self.receiver.records("logs")],
                         [index for index, (_, keep) in enumerate(vectors) if keep])
        client.update_log_sampling({"web": {"key": "attr:uid", "rules": [rule("cohort", .1)]}})
        for index in range(10000):
            client.log("info", "first", {"uid": str(index)})
            client.log("info", "second", {"uid": str(index)})
        client.flush()
        cohort = self.receiver.records("logs")[sum(keep for _, keep in vectors):]
        counts = collections.Counter(attributes(row)["uid"] for row in cohort)
        self.assertGreaterEqual(len(counts), 700)
        self.assertLessEqual(len(counts), 1300)
        self.assertEqual(set(counts.values()), {2})
        for row in cohort:
            self.assertEqual(attributes(row)["lightmoni.sampling.weight"], 10)

    def test_missing_sampling_key_uses_stable_instance_event_sequence(self):
        policy = {"key": "attr:uid", "rules": [rule("event", .5)]}
        client = self.client(log_sampling={"web": policy}, instance_id="golden")
        for index in range(50):
            attrs = {} if index % 2 else {"uid": ""}
            client.log("info", str(index + 1), attrs)
        client.flush()
        # Missing/empty key is selected by event_id golden:1..50. The expected
        # selection was produced using TypeScript sampleLog (key absent/empty).
        expected = [3, 4, 5, 7, 9, 11, 12, 14, 16, 18, 19, 21, 24, 25, 27, 29, 30, 31, 32, 34, 36, 37, 38, 39, 41, 42, 45, 49]
        self.assertEqual([int(row["body"]["stringValue"]) for row in self.receiver.records("logs")], expected)

    def test_table_isolation_remote_precedence_and_defensive_local_copy(self):
        local = {"web": {"rules": []}, "jobs": {"rules": [rule("local")]}}
        client = self.client(log_sampling=local, remote_config=True)
        jobs, other = client.with_table("jobs"), client.with_table("other")
        local["jobs"]["rules"].clear()
        self.receiver.config = snapshot("v1", {"web": {"rules": [rule("remote")]}})
        client.refresh_config()
        client.log("info", "remote web")
        jobs.log("info", "local jobs")
        other.log("info", "no policy")
        jobs.flush()
        self.assertEqual([r["body"]["stringValue"] for r in self.receiver.records("logs", "web")], ["remote web"])
        self.assertEqual([r["body"]["stringValue"] for r in self.receiver.records("logs", "jobs")], ["local jobs"])
        self.assertNotIn("lightmoni.sampling.rate", attributes(self.receiver.records("logs", "other")[0]))
        self.receiver.config = snapshot("v2")
        client.refresh_config()
        client.log("info", "local web denied")
        jobs.log("info", "local jobs again")
        client.flush()
        self.assertEqual(len(self.receiver.records("logs", "web")), 1)
        self.assertEqual(len(self.receiver.records("logs", "jobs")), 2)
        client.set_reporting_enabled(False)
        jobs.log("info", "shared stop")
        other.counter("requests").add(3)
        client.flush()
        self.assertTrue(jobs.stats()["reporting_disabled"])
        self.assertEqual(client.stats()["disabled_records"], 2)

    def test_empty_rules_zero_rate_and_business_sampling_leave_metrics_and_traces(self):
        client = self.client(log_sampling={"web": {"rules": []}})
        client.log("error", "no implicit error retention", {"uid": "blocked"})
        counter = client.counter("requests")
        counter.add(20, {"uid": "blocked"})
        client.start_span("blocked user", {"uid": "blocked"}).end()
        client.update_log_sampling({"web": {"rules": [rule("zero", 0)]}})
        client.log("fatal", "zero retention")
        client.flush()
        self.assertEqual(self.receiver.records("logs"), [])
        metrics = self.receiver.records("metrics")
        self.assertEqual(metrics[0]["sum"]["dataPoints"][0]["asInt"], "20")
        self.assertEqual([span["name"] for span in self.receiver.records("traces")], ["blocked user"])
        stats = client.stats()
        self.assertEqual(stats["unmatched_logs"], 1)
        self.assertEqual(stats["sampled_out_logs"], 1)
        self.assertEqual(stats["dropped_records"], 0)

    def test_self_telemetry_bypasses_business_log_rules(self):
        client = self.client(self_telemetry=True, log_sampling={"web": {"rules": []}})
        client.log("info", "business ignored")
        client.flush()
        logs = self.receiver.records("logs")
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["body"]["stringValue"], "LightMoni SDK started")
        self.assertEqual(attributes(logs[0])["sdk.language"], "python")
        self.assertGreater(len(self.receiver.records("metrics")), 0)
        self.assertEqual(client.stats()["unmatched_logs"], 1)

    def test_invalid_snapshot_is_atomic_bounded_and_errors_are_redacted(self):
        client = self.client(remote_config=True, key="auth-secret", config_key="config-secret")
        self.receiver.config = snapshot("good", {"web": {"rules": []}})
        client.refresh_config()
        invalid = [
            b'{"revision":"bad","log_sampling":{"web":{"rules":[{"name":"x","rate":true,"conditions":[]}]}}}',
            b'{"revision":"bad","log_sampling":{},"unknown":"response-secret"}',
            b'{"revision":"first","revision":"bad","log_sampling":{}}',
            b'{"revision":"bad","log_sampling":{"web":{"rules":[],"rules":[]}}}',
            b'{"revision":"bad","log_sampling":{"web":{"rules":[{"name":"x","rate":NaN,"conditions":[]}]}}}',
            b'{"revision":"bad","log_sampling":{"web":{"rules":[{"name":"x","rate":1,"conditions":[{"field":"attr:uid","operator":"in","values":[Infinity]}]}]}}}',
            b'{"revision":"bad","log_sampling":{},"padding":"' + b"x" * (1 << 20) + b'"}',
            b'{"revision":"bad","log_sampling":{},"disable_rules":[{"name":"all","conditions":[]}]}',
        ]
        for body in invalid:
            with self.subTest(body=body[:100]):
                self.receiver.get_action = lambda _request, body=body: (200, body, {})
                with self.assertRaises(Exception) as raised:
                    client.refresh_config()
                stats = client.stats()
                self.assertEqual(stats["config_revision"], "good")
                self.assertTrue(stats["config_error"])
                diagnostic = str(raised.exception) + stats["config_error"]
                for secret in ("auth-secret", "config-secret", "response-secret", self.receiver.url):
                    self.assertNotIn(secret, diagnostic)
                client.log("info", "old policy still active")
        client.flush()
        self.assertEqual(self.receiver.records("logs"), [])
        self.receiver.get_action = None
        self.receiver.config = snapshot("recovered", {"web": {"rules": [rule()]}})
        client.refresh_config()
        self.assertEqual(client.stats()["config_revision"], "recovered")
        self.assertEqual(client.stats()["config_error"], "")

    def test_credential_failure_and_slow_config_keep_last_snapshot(self):
        client = self.client(remote_config=True, key="auth-secret")
        self.receiver.config = snapshot("accepted", {"web": {"rules": []}})
        client.refresh_config()
        self.receiver.get_action = lambda request: (401, b"secret-provider-response", {})
        with self.assertRaises(Exception) as raised:
            client.refresh_config()
        self.assertEqual(client.stats()["config_revision"], "accepted")
        diagnostic = str(raised.exception) + client.stats()["config_error"]
        self.assertNotIn("auth-secret", diagnostic)
        self.assertNotIn("secret-provider-response", diagnostic)
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def slow(request):
            entered.set()
            release.wait(2)
            return 200, snapshot("too slow"), {}
        self.receiver.get_action = slow
        start = time.monotonic()
        with self.assertRaises(Exception):
            client.refresh_config(timeout=.15)
        self.assertTrue(entered.is_set())
        self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(client.stats()["config_revision"], "accepted")
        release.set()
        client.log("info", "still denied")
        client.flush()
        self.assertEqual(self.receiver.records("logs"), [])

    def test_concurrent_refresh_obeys_waiting_call_deadline(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def slow(request):
            entered.set()
            release.wait(2)
            return 200, snapshot("first"), {}
        self.receiver.get_action = slow
        client = self.client(remote_config=True)
        worker, outcomes = self.background(lambda: client.refresh_config(timeout=3))
        self.assertTrue(entered.wait(1))
        start = time.monotonic()
        with self.assertRaises(Exception):
            client.refresh_config(timeout=.1)
        self.assertLess(time.monotonic() - start, .4)
        self.assertEqual(len(self.receiver.observed("GET")), 1)
        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, [None])
        self.assertEqual(client.stats()["config_revision"], "first")

    def test_config_budget_covers_slow_response_body(self):
        client = self.client(remote_config=True)
        self.receiver.config = snapshot("accepted")
        client.refresh_config()
        stopped = threading.Event()
        body = json.dumps(snapshot("slow body")).encode()
        def drip(request):
            request.send_response(200)
            request.send_header("Content-Length", str(len(body)))
            request.end_headers()
            try:
                for byte in body:
                    request.wfile.write(bytes([byte]))
                    request.wfile.flush()
                    if stopped.wait(.04):
                        break
            except (BrokenPipeError, ConnectionResetError):
                pass
            return None
        self.addCleanup(stopped.set)
        self.receiver.get_action = drip
        start = time.monotonic()
        with self.assertRaises(Exception):
            client.refresh_config(timeout=.15)
        stopped.set()
        self.assertLess(time.monotonic() - start, .5)
        self.assertEqual(client.stats()["config_revision"], "accepted")
        self.assertTrue(client.stats()["config_error"])

    def test_configuration_keys_rotate_and_redirect_never_forwards_credentials(self):
        redirect = Receiver()
        self.addCleanup(redirect.close)
        client = self.client(remote_config=True, key="first-secret")
        client.refresh_config()
        client.update_key("second-secret")
        client.refresh_config()
        requests = self.receiver.observed("GET")
        self.assertEqual([request["headers"]["Authorization"] for request in requests], ["Bearer first-secret", "Bearer second-secret"])
        self.receiver.get_action = lambda request: (302, b"response-secret", {"Location": redirect.url + "/v1/sdk-config"})
        with self.assertRaises(Exception) as raised:
            client.refresh_config()
        self.assertEqual(redirect.observed(), [])
        diagnostic = str(raised.exception) + client.stats()["config_error"]
        for secret in ("second-secret", "response-secret", self.receiver.url, redirect.url):
            self.assertNotIn(secret, diagnostic)
        isolated = self.client(remote_config=True, key="telemetry", config_key="separate-secret", config_endpoint=redirect.url)
        isolated.refresh_config()
        isolated.update_key("rotated-telemetry")
        isolated.refresh_config()
        self.assertEqual([request["headers"]["Authorization"] for request in redirect.observed("GET")], ["Bearer separate-secret"] * 2)

    def test_http_proxy_handles_config_and_telemetry_and_no_proxy_bypass(self):
        proxy = Receiver()
        self.addCleanup(proxy.close)
        proxy.config = snapshot("through proxy", {"web": {"rules": [rule()]}})
        proxy_url = proxy.url.replace("http://", "http://proxy-user:proxy-secret@")
        with mock.patch.dict(os.environ, {
            "http_proxy": proxy_url, "https_proxy": proxy_url,
            "no_proxy": "", "NO_PROXY": "",
        }):
            target = "http://lightmoni-telemetry.invalid:4321"
            client = self.client(endpoint=target, key="telemetry-secret", remote_config=True)
            client.refresh_config(timeout=1)
            self.assertEqual(client.stats()["config_revision"], "through proxy")
            client.log("info", "through proxy")
            client.flush(timeout=1)
            requests = proxy.observed()
            self.assertEqual([(request["method"], request["path"]) for request in requests], [
                ("GET", target + "/v1/sdk-config"), ("POST", target + "/v1/logs"),
            ])
            for request in requests:
                self.assertEqual(request["headers"]["Authorization"], "Bearer telemetry-secret")
                self.assertEqual(request["headers"]["Proxy-Authorization"], "Basic cHJveHktdXNlcjpwcm94eS1zZWNyZXQ=")
                self.assertEqual(request["headers"]["Host"], "lightmoni-telemetry.invalid:4321")
            body = json.loads(requests[1]["body"])
            self.assertEqual(body["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"]["stringValue"], "through proxy")
            with mock.patch.dict(os.environ, {"no_proxy": "127.0.0.1", "NO_PROXY": "127.0.0.1"}):
                direct = self.client(remote_config=True)
                direct.refresh_config(timeout=1)
                direct.log("info", "direct bypass")
                direct.flush(timeout=1)
                self.assertEqual(len(proxy.observed()), 2)
                self.assertEqual([(request["method"], request["path"]) for request in self.receiver.observed()], [
                    ("GET", "/v1/sdk-config"), ("POST", "/v1/logs"),
                ])
                self.assertNotIn("Proxy-Authorization", self.receiver.observed()[0]["headers"])
                self.assertNotIn("Proxy-Authorization", self.receiver.observed()[1]["headers"])

    def test_https_proxy_url_never_sends_credentials_to_a_plain_http_peer(self):
        proxy = Receiver()
        self.addCleanup(proxy.close)
        secure_proxy = proxy.url.replace("http://", "https://proxy-user:proxy-secret@")
        with mock.patch.dict(os.environ, {"http_proxy": secure_proxy, "no_proxy": "", "NO_PROXY": ""}):
            client = self.client(endpoint="http://lightmoni-telemetry.invalid:4321", remote_config=True)
            with self.assertRaises(Exception) as raised:
                client.refresh_config(timeout=1)
            self.assertEqual(proxy.observed(), [], "HTTPS proxy must negotiate TLS before sending request or credentials")
            diagnostic = str(raised.exception) + client.stats()["config_error"]
            self.assertNotIn("proxy-secret", diagnostic)
            self.assertNotIn("proxy-user", diagnostic)

    def test_real_https_direct_connect_tunnel_and_tls_proxy(self):
        openssl = shutil.which("openssl")
        if openssl is None:
            self.skipTest("openssl unavailable for temporary TLS fixture")
        temporary = tempfile.TemporaryDirectory(prefix="lightmoni-sdk-tls-")
        self.addCleanup(temporary.cleanup)
        certificate = os.path.join(temporary.name, "certificate.pem")
        private_key = os.path.join(temporary.name, "private-key.pem")
        configuration = os.path.join(temporary.name, "openssl.cnf")
        with open(configuration, "w") as output:
            output.write("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n"
                         "[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n"
                         "basicConstraints=critical,CA:TRUE\n")
        # OpenSSL diagnostics and generated private key never enter tool output.
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-config", configuration, "-keyout", private_key, "-out", certificate],
                       check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(certificate, private_key)
        trusted_context = ssl.create_default_context(cafile=certificate)
        origin = Receiver(tls_context=server_context)
        self.addCleanup(origin.close)
        origin.config = snapshot("secure")
        connect_proxy = Receiver(tunnel_to=("127.0.0.1", origin.server.server_port))
        self.addCleanup(connect_proxy.close)
        tls_proxy = Receiver(tls_context=server_context)
        self.addCleanup(tls_proxy.close)
        tls_proxy.config = snapshot("TLS proxy")
        with mock.patch("ssl._create_default_https_context", return_value=trusted_context):
            with self.subTest(mode="direct HTTPS"):
                direct = self.client(endpoint=origin.url, remote_config=True, key="origin-secret")
                direct.refresh_config(timeout=2)
                direct.log("info", "direct HTTPS")
                direct.flush(timeout=2)
                self.assertEqual(direct.stats()["config_revision"], "secure")
                self.assertEqual([(request["method"], request["path"]) for request in origin.observed()], [
                    ("GET", "/v1/sdk-config"), ("POST", "/v1/logs"),
                ])
            with self.subTest(mode="HTTPS through HTTP CONNECT"):
                proxy_address = connect_proxy.url.replace("http://", "http://proxy-user:proxy-secret@")
                with mock.patch.dict(os.environ, {"https_proxy": proxy_address, "no_proxy": "", "NO_PROXY": ""}):
                    tunneled = self.client(endpoint=origin.url, remote_config=True, key="origin-secret")
                    tunneled.refresh_config(timeout=2)
                    tunneled.log("info", "HTTPS CONNECT")
                    tunneled.flush(timeout=2)
                requests = connect_proxy.observed()
                self.assertEqual([request["method"] for request in requests], ["CONNECT", "CONNECT"])
                self.assertEqual([request["path"] for request in requests], ["localhost:%d" % origin.server.server_port] * 2)
                for request in requests:
                    self.assertEqual(request["headers"]["Proxy-Authorization"], "Basic cHJveHktdXNlcjpwcm94eS1zZWNyZXQ=")
                    self.assertNotIn("Authorization", request["headers"])
                self.assertEqual(tunneled.stats()["config_revision"], "secure")
                self.assertEqual([row["body"]["stringValue"] for row in origin.records("logs")], ["direct HTTPS", "HTTPS CONNECT"])
                for request in origin.observed():
                    self.assertEqual(request["headers"]["Authorization"], "Bearer origin-secret")
                    self.assertNotIn("Proxy-Authorization", request["headers"])
            with self.subTest(mode="HTTP through HTTPS proxy"):
                target = "http://lightmoni-telemetry.invalid:4321"
                proxy_address = tls_proxy.url.replace("https://", "https://proxy-user:proxy-secret@")
                with mock.patch.dict(os.environ, {"http_proxy": proxy_address, "no_proxy": "", "NO_PROXY": ""}):
                    proxied = self.client(endpoint=target, remote_config=True)
                    proxied.refresh_config(timeout=2)
                    proxied.log("info", "TLS protected proxy")
                    proxied.flush(timeout=2)
                self.assertEqual(proxied.stats()["config_revision"], "TLS proxy")
                self.assertEqual([(request["method"], request["path"]) for request in tls_proxy.observed()], [
                    ("GET", target + "/v1/sdk-config"), ("POST", target + "/v1/logs"),
                ])
                for request in tls_proxy.observed():
                    self.assertEqual(request["headers"]["Proxy-Authorization"], "Basic cHJveHktdXNlcjpwcm94eS1zZWNyZXQ=")

    def test_remote_and_local_stop_clear_buffers_and_invalidate_old_spans(self):
        client = self.client(remote_config=True, self_telemetry=True, resource={"deployment.env": "qa"})
        child = client.with_table("jobs")
        counter = child.counter("requests")
        old_span = client.start_span("before stop")
        counter.add(10)
        child.log("info", "before stop")
        self.receiver.config = snapshot("stopped", disabled=[{"name": "qa Python", "conditions": [
            condition("sdk.language", "python"), condition("resource:deployment.env", "qa"), condition("instance_id", "test-instance")]}])
        client.refresh_config()
        stopped_span = child.start_span("during stop")
        counter.add(100)
        child.log("info", "during stop")
        client.set_reporting_enabled(True)
        client.flush()
        self.assertEqual(self.receiver.observed("POST"), [])
        stats = client.stats()
        self.assertTrue(stats["reporting_disabled"])
        self.assertEqual((stats["pending_batches"], stats["pending_bytes"], stats["buffer_bytes"]), (0, 0, 0))
        client.set_reporting_enabled(False)
        self.receiver.config = snapshot("remote resumed")
        client.refresh_config()
        self.assertTrue(client.stats()["reporting_disabled"])
        client.set_reporting_enabled(True)
        old_span.end()
        stopped_span.end()
        child.log("info", "fresh")
        counter.add(3)
        child.start_span("fresh span").end()
        client.flush()
        self.assertEqual([r["body"]["stringValue"] for r in self.receiver.records("logs", "jobs")], ["fresh"])
        self.assertEqual(self.receiver.records("metrics", "jobs")[0]["sum"]["dataPoints"][0]["asInt"], "3")
        self.assertEqual([r["name"] for r in self.receiver.records("traces")], ["fresh span"])
        self.assertEqual(client.stats()["dropped_records"], 0)

    def test_stop_cancels_waiting_http_and_old_ack_cannot_corrupt_resumed_queue(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        calls = []
        def post(request):
            calls.append(request)
            if len(calls) == 1:
                entered.set()
                release.wait(5)
            return 200, {}, {}
        self.receiver.post_action = post
        client = self.client()
        client.log("info", "already submitted")
        worker, outcomes = self.background(lambda: client.flush(timeout=10))
        self.assertTrue(entered.wait(2))
        start = time.monotonic()
        client.set_reporting_enabled(False)
        worker.join(.9)
        self.assertFalse(worker.is_alive(), "waiting response did not cancel within one second")
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(outcomes, [None], "intentional stop must not turn flush into delivery failure")
        client.set_reporting_enabled(True)
        client.log("info", "fresh submission")
        client.flush(timeout=1)
        release.set()
        self.assertEqual(client.stats()["delivered_batches"], 1)
        self.assertEqual(client.stats()["pending_batches"], 0)
        self.assertEqual(len(calls), 2)

    def test_stop_interrupts_authentication_retry_wait(self):
        self.receiver.post_action = lambda request: (401, b"secret-provider-response", {"Retry-After": "30"})
        client = self.client(key="auth-secret")
        client.log("info", "retrying")
        worker, outcomes = self.background(lambda: client.flush(timeout=10))
        self.wait_for(lambda: client.stats()["retried_batches"] >= 1)
        start = time.monotonic()
        client.set_reporting_enabled(False)
        worker.join(.9)
        self.assertFalse(worker.is_alive(), "retry wait did not cancel within one second")
        self.assertLess(time.monotonic() - start, 1)
        self.assertEqual(outcomes, [None])
        self.assertEqual(len(self.receiver.observed("POST")), 1)
        self.assertEqual(client.stats()["pending_batches"], 0)
        self.assertEqual(client.stats()["dropped_records"], 0)

    def test_policy_only_update_preserves_frozen_retry_body_and_identity(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        attempts = []
        def post(request):
            attempts.append(request)
            if len(attempts) == 1:
                entered.set()
                release.wait(3)
                return 503, {}, {}
            return 200, {}, {}
        self.receiver.post_action = post
        client = self.client(log_sampling={"web": {"rules": [rule("before")]}})
        client.log("info", "frozen")
        worker, outcomes = self.background(lambda: client.flush(timeout=3))
        self.assertTrue(entered.wait(1))
        client.update_log_sampling({"web": {"rules": []}})
        client.log("info", "new policy denied")
        release.set()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, [None])
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["body"], attempts[1]["body"])
        for key in ("X-Lightmoni-Batch-ID", "X-Lightmoni-Batch-Created-At"):
            self.assertEqual(attempts[0]["headers"][key], attempts[1]["headers"][key])
        self.assertEqual(client.stats()["retried_batches"], 1)
        self.assertEqual(client.stats()["unmatched_logs"], 1)

    def test_oversized_acknowledgment_retains_existing_permanent_rejection(self):
        for status in (200, 400):
            with self.subTest(status=status):
                before = len(self.receiver.observed("POST"))
                self.receiver.post_action = lambda request, status=status: (status, b"x" * 65537, {})
                client = self.client()
                client.log("info", "one record")
                with self.assertRaises(RuntimeError):
                    client.flush(timeout=.6)
                stats = client.stats()
                self.assertEqual(stats["rejected_records"], 1)
                self.assertEqual(stats["retried_batches"], 0)
                self.assertEqual(stats["pending_batches"], 0)
                self.assertEqual(len(self.receiver.observed("POST")), before + 1)

    def test_polling_is_independent_of_self_telemetry_and_stops_at_shutdown(self):
        client = self.client(remote_config=True, config_interval=1)
        self.assertEqual(self.receiver.observed("GET"), [])
        self.receiver.config = snapshot("paused", disabled=[{"name": "service", "conditions": [condition("service", "reporting-test")]}])
        self.wait_for(lambda: client.stats()["config_revision"] == "paused", timeout=2)
        self.assertTrue(client.stats()["reporting_disabled"])
        self.receiver.config = snapshot("resumed")
        self.wait_for(lambda: client.stats()["config_revision"] == "resumed", timeout=2)
        self.assertFalse(client.stats()["reporting_disabled"])
        self.assertEqual(self.receiver.observed("POST"), [])
        client.shutdown(timeout=.3)
        count = len(self.receiver.observed("GET"))
        time.sleep(1.05)
        self.assertEqual(len(self.receiver.observed("GET")), count)

    def test_shutdown_prevents_an_inflight_config_response_from_applying(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def config(request):
            entered.set()
            release.wait(3)
            return 200, snapshot("too late"), {}
        self.receiver.get_action = config
        client = self.client(remote_config=True)
        worker, _outcomes = self.background(lambda: client.refresh_config(timeout=4))
        self.assertTrue(entered.wait(1))
        client.shutdown(timeout=.3)
        release.set()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(client.stats()["config_revision"], "")

    def test_concurrent_child_shutdown_waits_without_cancelling_owner_flush(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def post(request):
            entered.set()
            release.wait(3)
            return 200, {}, {}
        self.receiver.post_action = post
        client = self.client()
        child = client.with_table("jobs")
        child.log("info", "shutdown owner must deliver")
        owner, owner_outcomes = self.background(lambda: client.shutdown(timeout=2))
        self.assertTrue(entered.wait(1))
        with self.assertRaises(TimeoutError):
            child.shutdown(timeout=.1)
        self.assertTrue(owner.is_alive(), "timed-out follower must not cancel the owner's final flush")
        follower, follower_outcomes = self.background(lambda: child.shutdown(timeout=1))
        follower.join(.05)
        self.assertTrue(follower.is_alive(), "child shutdown must wait for the shared final flush")
        release.set()
        owner.join(1)
        follower.join(1)
        self.assertFalse(owner.is_alive())
        self.assertFalse(follower.is_alive())
        self.assertEqual(owner_outcomes, [None])
        self.assertEqual(follower_outcomes, [None])
        self.assertEqual(client.stats()["delivered_batches"], 1)
        self.assertEqual(client.stats()["pending_batches"], 0)
        self.assertEqual(len(self.receiver.observed("POST")), 1)

    def test_invalid_local_update_preserves_effective_policy(self):
        client = self.client(log_sampling={"web": {"rules": []}})
        with self.assertRaises(ValueError):
            client.update_log_sampling({"web": {"rules": [rule("invalid", True)]}})
        client.log("info", "must remain denied")
        client.flush()
        self.assertEqual(self.receiver.records("logs"), [])

    def test_public_configuration_validation(self):
        for options in ({"config_interval": True}, {"config_interval": .5}, {"config_interval": float("inf")},
                        {"instance_id": ""}, {"resource": {"service.name": "overridden"}},
                        {"config_endpoint": "https://secret@example.com"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.client(**options)
        client = self.client(remote_config=True)
        for timeout in (0, -1, True, float("nan")):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                client.refresh_config(timeout=timeout)


class ClosedResponseTransportTests(unittest.TestCase):
    def test_complete_close_responses_do_not_retry_an_already_received_ack(self):
        from lightmoni.transport import Request, Cancelled
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                class Handler(BaseHTTPRequestHandler):
                    protocol_version = "HTTP/1.1"
                    def log_message(self, *args):
                        pass
                    def do_POST(self):
                        self.rfile.read(int(self.headers.get("Content-Length", "0")))
                        self.send_response(200)
                        self.send_header("Connection", "close")
                        if chunked:
                            self.send_header("Transfer-Encoding", "chunked")
                        else:
                            self.send_header("Content-Length", "2")
                        self.end_headers()
                        self.wfile.write(b"2\r\n{}\r\n0\r\n\r\n" if chunked else b"{}")
                        self.wfile.flush()
                server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    request = Request("http://127.0.0.1:%d/v1/logs" % server.server_port, time.monotonic() + 2)
                    status, _, body = request.exchange("POST", b"{}", {"Content-Type": "application/json"})
                    self.assertEqual((status, body), (200, b"{}"))
                    request.cancel()
                    with self.assertRaises(Cancelled):
                        request._check()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
