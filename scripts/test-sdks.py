#!/usr/bin/env python3
"""Cross-language protocol and fault conformance against a real HTTP receiver."""
import argparse
import json
import os
import re
import socket
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import uuid

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".lightmoni/sdk-test"
IMAGES = {"php": "m.daocloud.io/docker.io/library/php:8.3-cli",
          "rust": "m.daocloud.io/docker.io/library/rust:1-bookworm"}


def command(language, docker):
    commands = {
        "python": ["python3", "examples/sdk/python/main.py"],
        "ruby": ["ruby", "examples/sdk/ruby/main.rb"],
        "php": ["php", "examples/sdk/php/main.php"],
        "rust": [".lightmoni/sdk-test/rust/debug/examples/demo"],
    }
    if docker and language in IMAGES:
        return ["docker", "run", "--rm", "-v", str(ROOT) + ":/work", "-w", "/work",
                "-e", "LIGHTMONI_ENDPOINT", "-e", "LIGHTMONI_KEY", "-e", "LIGHTMONI_TEST_MODE",
                "-e", "LIGHTMONI_SERVICE", "-e", "PYTHONPATH", IMAGES[language]] + commands[language]
    return commands[language]


def prepare(languages, docker):
    CACHE.mkdir(parents=True, exist_ok=True)
    builds = {
        "rust": ["cargo", "build", "--manifest-path", "sdk/rust/Cargo.toml", "--example", "demo"],
    }
    for language in languages:
        if language not in builds:
            continue
        cmd = builds[language]
        env = dict(os.environ, CARGO_TARGET_DIR=str(CACHE / "rust"))
        if docker:
            cmd = ["docker", "run", "--rm", "-v", str(ROOT) + ":/work", "-w", "/work",
                   "-e", "CARGO_TARGET_DIR=/work/.lightmoni/sdk-test/rust", IMAGES[language]] + cmd
        subprocess.run(cmd, cwd=ROOT, env=env, check=True)


class Receiver(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, bind):
        super().__init__((bind, 0), Handler)
        self.lock = threading.Lock()
        self.attempts = []
        self.fault = "fixture"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *_):
        pass

    def do_GET(self):
        data = json.dumps({name: self.headers.get(name, "") for name in ("traceparent", "tracestate", "x-business")}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        body = json.loads(raw)
        identity = self.headers["X-Lightmoni-Batch-ID"]
        uuid.UUID(identity)
        from datetime import datetime
        created = re.sub(r"(\.\d{6})\d+", r"\1", self.headers["X-Lightmoni-Batch-Created-At"])
        datetime.fromisoformat(created.replace("Z", "+00:00"))
        assert self.headers["Content-Type"].startswith("application/json")
        row = dict(id=identity, created=self.headers["X-Lightmoni-Batch-Created-At"],
                   table=self.headers["X-Lightmoni-Table"], signal=self.path.rsplit("/", 1)[1],
                   raw=raw, body=body, rotated=self.headers.get("Authorization") == "Bearer rotated")
        with self.server.lock:
            self.server.attempts.append(row)
            fault = self.server.fault
        status, reply, extra = 200, {}, {}
        if fault in ("retry", "rate", "auth", "invalid_ack") and not row["rotated"]:
            status = {"retry": 503, "rate": 429, "auth": 401, "invalid_ack": 200}[fault]
            if fault == "rate":
                extra["Retry-After"] = "1"
            if fault == "invalid_ack":
                reply = b"not-json"
        if fault == "ack_loss" and not row["rotated"]:
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if fault == "permanent":
            status = 400
        if fault == "partial":
            reply = {"partialSuccess": {"rejectedDataPoints": "1"}}
        data = reply if isinstance(reply, bytes) else json.dumps(reply).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for key, value in extra.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def records(attempts, signal):
    resource, scope, field = {"metrics": ("resourceMetrics", "scopeMetrics", "metrics"),
                              "logs": ("resourceLogs", "scopeLogs", "logRecords"),
                              "traces": ("resourceSpans", "scopeSpans", "spans")}[signal]
    rows = []
    for batch in attempts:
        if batch["signal"] != signal:
            continue
        for res in batch["body"][resource]:
            identity = {a["key"]: a["value"] for a in res["resource"]["attributes"]}
            assert identity["service.instance.id"]["stringValue"]
            assert identity["service.name"]["stringValue"].startswith("conformance-")
            for group in res[scope]:
                rows.extend(group[field])
    return rows


def validate(fault, attempts, stats):
    if fault == "fixture":
        metrics = records(attempts, "metrics")
        requests = [p for m in metrics if m["name"] == "http.requests" for p in m["sum"]["dataPoints"]]
        assert sorted(int(p["asInt"]) for p in requests) == [1, 1, 1, 2, 3], requests
        first = [p for p in requests if any(a["key"] == "status" and a["value"] == {"intValue": "200"} for a in p["attributes"])]
        assert len(first) == 1 and first[0]["asInt"] == "3"
        typed = [p["attributes"][0]["value"] for p in requests if p["attributes"] and p["attributes"][0]["key"] == "typed"]
        assert {"intValue": "1"} in typed and {"stringValue": "1"} in typed
        exact = [m for m in metrics if m["name"] == "exact"]
        assert exact[0]["sum"]["dataPoints"][0]["asInt"] == "9007199254740993"
        gauges = [p for m in metrics if m["name"] == "active" for p in m["gauge"]["dataPoints"]]
        assert len(gauges) == 1 and gauges[0]["asDouble"] == 7
        hist = [m for m in metrics if m["name"] == "duration"][0]["histogram"]["dataPoints"][0]
        assert hist["bucketCounts"] == ["2", "2", "1"] and hist["count"] == "5" and hist["sum"] == 31
        logs, spans = records(attempts, "logs"), records(attempts, "traces")
        assert len(logs) == 3 and len(spans) == 1
        by_body = {log["body"]["stringValue"]: log for log in logs}
        for body in ("without trace", "after trace"):
            assert not by_body[body].get("traceId") and not by_body[body].get("spanId")
            assert not by_body[body].get("flags")
        plain_attrs = {a["key"]: a["value"] for a in by_body["without trace"]["attributes"]}
        assert plain_attrs == {"trace_id": {"stringValue": "attribute-only"}}
        traced = by_body["中文 fixture"]
        assert traced["traceId"] == spans[0]["traceId"] == "a" * 32
        assert traced["spanId"] == spans[0]["spanId"] and traced["flags"] == 1
        assert spans[0]["parentSpanId"] == "b" * 16 and spans[0]["traceState"] == "foo=bar"
        values = {a["key"]: a["value"] for a in traced["attributes"]}
        assert values == {"exact": {"intValue": "9007199254740993"}, "ok": {"boolValue": True}, "fraction": {"doubleValue": .125}}
        assert {b["table"] for b in attempts} == {"http", "app"}
        assert stats["invalid_records"] == 1
        assert stats["pending_batches"] == stats["pending_bytes"] == 0
    elif fault == "demo":
        logs = [log for log in records(attempts, "logs") if log["body"]["stringValue"] == "sample payment completed"]
        spans = records(attempts, "traces")
        assert len(logs) == len(spans) == 20
        identities = {(span["traceId"], span["spanId"]) for span in spans}
        assert len(identities) == 20 and all((log["traceId"], log["spanId"]) in identities for log in logs)
        metrics = records(attempts, "metrics")
        assert sum(int(p["asInt"]) for m in metrics if m["name"] == "http.requests" for p in m["sum"]["dataPoints"]) == 20
        assert stats["invalid_records"] == stats["pending_batches"] == 0
    elif fault == "trace_scope":
        logs, spans = records(attempts, "logs"), records(attempts, "traces")
        assert len(logs) == 8 and len(spans) == 2
        by_body = {log["body"]["stringValue"]: log for log in logs}
        by_name = {span["name"]: span for span in spans}
        root, child = by_name["request"], by_name["child"]
        assert root["traceId"] == child["traceId"] == "a" * 32
        assert root["parentSpanId"] == "b" * 16 and child["parentSpanId"] == root["spanId"]
        assert root["spanId"] != child["spanId"] and child["status"]["code"] == 2
        assert root["flags"] == child["flags"] == 0 and root["traceState"] == child["traceState"] == "vendor=scope"
        for body, span in (("scope root", root), ("scope child", child), ("scope restored", root)):
            log = by_body[body]
            assert log["traceId"] == span["traceId"] and log["spanId"] == span["spanId"] and log["flags"] == 0
        assert by_body["scope explicit"]["traceId"] == "c" * 32 and by_body["scope explicit"]["spanId"] == "d" * 16
        for value in (1, 2):
            log = by_body["scope concurrent " + str(value)]
            assert log["traceId"] == str(value) * 32 and log["spanId"] == str(value) * 16
        for body in ("without trace", "after trace"):
            assert not by_body[body].get("traceId") and not by_body[body].get("spanId")
        assert stats["invalid_records"] == stats["pending_batches"] == 0
    elif fault == "overflow":
        points = [p for m in records(attempts, "metrics") for p in m["sum"]["dataPoints"]]
        assert len(points) == 3 and sum(int(p["asInt"]) for p in points) == 4
        overflow = [p for p in points if p["attributes"] == [{"key": "otel.metric.overflow", "value": {"boolValue": True}}]]
        assert len(overflow) == 1 and overflow[0]["asInt"] == "2" and stats["overflow_records"] == 2
    elif fault in ("retry", "rate", "auth", "invalid_ack", "ack_loss"):
        groups = {}
        for attempt in attempts:
            groups.setdefault(attempt["id"], []).append(attempt)
        assert len(groups) == 2, attempts
        first = next(iter(groups.values()))
        assert len(first) >= 2
        assert all(p["raw"] == first[0]["raw"] and p["created"] == first[0]["created"] for p in first)
        assert first[-1]["rotated"] and not first[0]["rotated"]
        accepted = [p[-1] for p in groups.values()]
        points = [p for m in records(accepted, "metrics") for p in m["sum"]["dataPoints"]]
        assert sorted(int(p["asInt"]) for p in points) == [1, 2]
        assert stats["pending_batches"] == 0 and stats["retried_batches"] > 0
    elif fault in ("permanent", "partial"):
        assert len(attempts) == 1 and stats["rejected_records"] == 1 and stats["pending_batches"] == 0
    elif fault == "capacity":
        assert not attempts and stats["dropped_records"] == 1 and stats["pending_bytes"] == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--languages", default="python,ruby,php,rust")
    parser.add_argument("--docker", action="store_true", help="PHP/Rust in isolated runtime containers")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--cases", default="fixture,trace_scope,demo,overflow,retry,rate,auth,invalid_ack,ack_loss,permanent,partial,capacity")
    parser.add_argument("--agent-url", help="run business demos against an actual Agent instead of fault fixtures")
    args = parser.parse_args()
    languages = args.languages.split(",")
    if not args.skip_build:
        prepare(languages, args.docker)
    if args.agent_url:
        for language in languages:
            endpoint = args.agent_url.replace("127.0.0.1", "host.docker.internal") if args.docker and language in IMAGES else args.agent_url
            env = dict(os.environ, LIGHTMONI_ENDPOINT=endpoint, LIGHTMONI_SERVICE="conformance-" + language,
                       LIGHTMONI_KEY="", LIGHTMONI_TEST_MODE="demo", PYTHONPATH=str(ROOT / "sdk/python"))
            subprocess.run(command(language, args.docker), cwd=ROOT, env=env, check=True, timeout=45)
        return
    receiver = Receiver("0.0.0.0" if args.docker else "127.0.0.1")
    threading.Thread(target=receiver.serve_forever, daemon=True).start()
    try:
        for language in languages:
            for fault in args.cases.split(","):
                with receiver.lock:
                    receiver.fault, receiver.attempts = fault, []
                host = "host.docker.internal" if args.docker and language in IMAGES else "127.0.0.1"
                mode = "retry" if fault in ("rate", "invalid_ack", "ack_loss") else fault
                env = dict(os.environ, LIGHTMONI_ENDPOINT=f"http://{host}:{receiver.server_port}",
                           LIGHTMONI_SERVICE="conformance-" + language, LIGHTMONI_KEY="initial",
                           LIGHTMONI_TEST_MODE=mode, PYTHONPATH=str(ROOT / "sdk/python"))
                result = subprocess.run(command(language, args.docker), cwd=ROOT, env=env, capture_output=True, text=True, timeout=45)
                if result.returncode:
                    raise AssertionError(f"{language}/{fault}: {result.stdout}\n{result.stderr}")
                stats = json.loads(result.stdout.strip().splitlines()[-1])
                with receiver.lock:
                    validate(fault, receiver.attempts, stats)
                print(f"PASS {language}/{fault}", flush=True)
    finally:
        receiver.shutdown()
        receiver.server_close()


if __name__ == "__main__":
    main()
