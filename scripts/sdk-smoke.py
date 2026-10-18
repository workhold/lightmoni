#!/usr/bin/env python3
"""Six supported SDKs -> Agent or direct service -> real ClickHouse."""
import argparse
from datetime import datetime, timezone, timedelta
from decimal import Decimal
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sdk_runner", ROOT / "scripts/test-sdks.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server-url", default="http://127.0.0.1:19380")
    parser.add_argument("--mode", choices=["agent", "direct"], default="agent")
    parser.add_argument("--container-endpoint", help="direct center URL reachable from SDK containers")
    parser.add_argument("--docker-network", help="network for PHP/Rust demo containers")
    parser.add_argument("--agent-port", type=int, default=19318)
    parser.add_argument("--report", default=".lightmoni/sdk-test/e2e.json")
    args = parser.parse_args()
    work = ROOT / ".lightmoni/sdk-test/e2e"
    work.mkdir(parents=True, exist_ok=True)
    cookie = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie))

    def api(path, body=None, method=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(args.server_url + "/api/v1" + path, data, {"Content-Type": "application/json"}, method=method)
        with client.open(req, timeout=30) as response:
            return json.load(response)

    account = {"name": os.getenv("LIGHTMONI_TEST_USER", "sdk-local-admin"),
               "password": os.getenv("LIGHTMONI_TEST_PASSWORD", "sdk-local-test-password")}
    if api("/setup")["required"]:
        api("/setup", account)
    else:
        api("/auth/login", account)
    key = api("/keys", {"name": "sdk-six-languages-" + args.mode, "allowed_tables": ["http", "app", "host", "probe"]})
    token = secrets.token_urlsafe(24)
    config = work / "agent.json"
    config.write_text(json.dumps({
        "listen": f"0.0.0.0:{args.agent_port}", "endpoint": args.server_url, "key": key["key"],
        "local_token": token, "data_dir": str(work / ("agent-" + key["id"])),
        "min_free_bytes": 0, "collect_interval_seconds": 3600,
    }))
    config.chmod(0o600)
    with (work / "agent.log").open("w") as log:
        agent = subprocess.Popen([str(ROOT / ".lightmoni/sdk-test/lightmoni-agent"), "run", "--config", str(config)], stdout=log, stderr=log) if args.mode == "agent" else None
        try:
            for _ in range(50 if agent else 0):
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{args.agent_port}/healthz", timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    if agent.poll() is not None:
                        raise RuntimeError("test Agent failed to start; inspect .lightmoni/sdk-test/e2e/agent.log")
                    time.sleep(.1)
            languages = ["go", "node", "python", "php", "ruby", "rust"]
            for language in languages:
                host = "host.docker.internal" if language in runner.IMAGES else "127.0.0.1"
                endpoint = (args.container_endpoint or args.server_url.replace("127.0.0.1", host).replace("localhost", host)) if args.mode == "direct" and language in runner.IMAGES else args.server_url if args.mode == "direct" else f"http://{host}:{args.agent_port}"
                env = dict(os.environ, LIGHTMONI_ENDPOINT=endpoint,
                           LIGHTMONI_SERVICE=f"sdk-{args.mode}-{language}-{key['id'][:8]}", LIGHTMONI_KEY=key["key"] if args.mode == "direct" else token,
                           LIGHTMONI_TEST_MODE="demo", LIGHTMONI_COUNT="20", PYTHONPATH=str(ROOT / "sdk/python"))
                cmd = ["go", "run", "./examples/sdk/go"] if language == "go" else ["node", "examples/sdk/node/index.mjs"] if language == "node" else runner.command(language, True)
                if args.docker_network and language in runner.IMAGES:
                    cmd[2:2] = ["--network", args.docker_network]
                subprocess.run(cmd, cwd=ROOT, env=env, check=True, timeout=60, stdout=subprocess.DEVNULL)
            now = datetime.now(timezone.utc)
            query = {
                "request_id": "sdk-six-languages", "range": {"from": (now-timedelta(hours=1)).isoformat(), "to": (now+timedelta(minutes=1)).isoformat()}, "interval_ms": 60000,
                "queries": [
                    {"refId": "counts", "sql": "SELECT service,sum(toDecimal256(value_int,0)) AS total FROM metric_http_sum WHERE key_id={key:String} AND name='http.requests' GROUP BY service"},
                    {"refId": "links", "sql": "SELECT l.service,count() AS total FROM log_app l JOIN trace_app t ON l.trace_id=t.trace_id AND l.span_id=t.span_id WHERE l.key_id={key:String} GROUP BY l.service"},
                    {"refId": "histogram", "sql": "SELECT service,sum(count) AS total FROM metric_http_histogram WHERE key_id={key:String} AND name='http.duration' GROUP BY service"},
                    {"refId": "gauge", "sql": "SELECT service,argMax(value,event_time) AS last FROM metric_http_gauge WHERE key_id={key:String} AND name='http.active' GROUP BY service"},
                    {"refId": "self_heartbeat", "sql": "SELECT service,max(value_float) AS total FROM metric_lightmoni_sdk_gauge WHERE key_id={key:String} AND name='lightmoni.sdk.heartbeat' AND attributes['source_table']='http' GROUP BY service"},
                    {"refId": "self_logs", "sql": "SELECT service,count() AS total FROM log_lightmoni_sdk WHERE key_id={key:String} AND attributes['source_table']='http' GROUP BY service"},
                ],
            }
            for q in query["queries"]:
                q["params"] = {"key": {"type": "String", "value": key["id"]}}
            for _ in range(60):
                result = api("/query", query)
                if all(r["status"] == "success" and len(r["frames"][0]["rows"]) == 8 for r in result["results"]):
                    break
                time.sleep(.5)
            expected = {"counts": 20, "links": 20, "histogram": 20, "gauge": 3, "self_heartbeat": 1, "self_logs": 1}
            summary = {}
            for r in result["results"]:
                assert r["status"] == "success", r
                rows = r["frames"][0]["rows"]
                assert {row[0] for row in rows} == {f"sdk-{args.mode}-{language}-{key['id'][:8]}" for language in languages}, rows
                assert all(Decimal(str(row[1])) == expected[r["refId"]] for row in rows), rows
                summary[r["refId"]] = {row[0]: str(row[1]) for row in rows}
            install = api("/sdk-install")
            assert len(install["packages"]) == 6 and all(p["available"] for p in install["packages"])
            for p in install["packages"]:
                with urllib.request.urlopen(p["url"], timeout=10) as response:
                    assert response.status == 200 and response.read(2) == b"\x1f\x8b"
            report = {"languages": languages, "path": "SDK -> service -> ClickHouse" if args.mode == "direct" else "SDK -> Agent SQLite -> service -> ClickHouse", "results": summary, "packages": len(install["packages"])}
            target = ROOT / args.report
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
            print("PASS six SDKs: per service 20 Counter, 20 linked logs/spans, 20 Histogram, Gauge=3, SDK heartbeats/internal logs; six downloads")
        finally:
            if agent:
                agent.terminate()
                try:
                    agent.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    agent.kill()
                    agent.wait()
            api("/keys/" + key["id"], {"active": False}, method="PUT")


if __name__ == "__main__":
    main()
