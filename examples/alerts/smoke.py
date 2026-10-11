#!/usr/bin/env python3
"""Real server + ClickHouse + Webhook trigger/recovery smoke, stdlib only.

Use an isolated LightMoni instance. Supply LIGHTMONI_USERNAME and
LIGHTMONI_PASSWORD or LIGHTMONI_COOKIE without writing credentials to this file.
"""
import argparse
import http.cookiejar
import http.server
import json
import os
import threading
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:18880")
    parser.add_argument("--keep", action="store_true", help="Keep created fixtures for UI review")
    args = parser.parse_args()
    received = []
    lock = threading.Lock()

    class Hook(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert self.headers.get("X-LightMoni-Event-ID") == payload["event_id"]
            with lock:
                received.append(payload)
                first = len(received) == 1
            self.send_response(429 if first else 202)
            if first:
                self.send_header("Retry-After", "1")
            self.end_headers()
        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    jar = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    cookie = os.environ.get("LIGHTMONI_COOKIE")

    def api(path, body=None, method=None):
        request = urllib.request.Request(args.url + "/api/v1" + path,
            data=None if body is None else json.dumps(body).encode(),
            method=method or ("POST" if body is not None else "GET"),
            headers={"Content-Type": "application/json", **({"Cookie": cookie} if cookie else {})})
        with client.open(request, timeout=15) as response:
            return json.load(response)

    if not cookie:
        api("/auth/login", {"name": os.environ["LIGHTMONI_USERNAME"],
                            "password": os.environ["LIGHTMONI_PASSWORD"]})
    catalog = api("/catalog/tables")
    selected = [next(t for t in catalog if t["name"] == name)
                for name in ("log_app", "metric_http_sum")]
    channel = None
    groups = []
    rule = None
    try:
        channel = api("/notify/channels", {"name": "Local webhook smoke", "type": "webhook",
            "enabled": True, "config": {"url": f"http://127.0.0.1:{server.server_port}/hook"}})
        for table in selected:
            group = api("/alerts/groups", {"name": "Smoke " + table["name"], "enabled": True,
                "targets": [{"channel_id": channel["id"],
                    "recipient": {"kind": "channel", "value": "bound"}}]})
            groups.append(group)
            api("/catalog/tables/" + table["id"], {"alert_group_id": group["id"]}, "PUT")
        # Alternate a controlled fault while executing actual ClickHouse queries
        # against both sources. This expression is a test fixture, not host data.
        sql = ("SELECT if(toUnixTimestamp(now()) % 12 < 6, 1, 0) "
               "+ 0 * (SELECT count() FROM log_app) "
               "+ 0 * (SELECT count() FROM metric_http_sum) AS value")
        draft = {"name": "Cross-table trigger / recovery smoke", "enabled": True,
            "source_table_ids": [t["id"] for t in selected], "sql": sql,
            "value_field": "value", "label_fields": [], "operator": "gt", "threshold": "0",
            "interval_seconds": 1, "window_seconds": 60, "for_seconds": 0,
            "recovery_seconds": 0, "delay_seconds": 0, "repeat_seconds": 0,
            "health_for_seconds": 0, "notify_health": True, "services": []}
        preview = api("/alerts/preview", draft)
        assert len(preview["routes"]) == 1, preview
        assert len(preview["routes"][0]["group_ids"]) == 2, preview
        assert preview["states"][0]["health"] == "ok", preview
        rule = api("/alerts/rules", draft)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            time.sleep(0.5)
            records = api("/notify/deliveries?rule_id=" + rule["id"])
            accepted = {d["payload"]["kind"] for d in records if d["status"] == "accepted"}
            if {"firing", "resolved"} <= accepted:
                assert all(len(d["group_ids"]) == 2 for d in records), records
                assert any(d["attempts"] >= 2 for d in records), records
                print(json.dumps({"status": "passed", "rule_id": rule["id"],
                    "source_tables": [t["name"] for t in selected],
                    "deduplicated_route_count": len(preview["routes"]),
                    "accepted_kinds": sorted(accepted), "webhook_requests": len(received),
                    "provider_channels": "Not tested: no third-party credentials supplied"}, indent=2))
                break
        else:
            raise AssertionError("trigger/recovery timeout: " + json.dumps(records))
    finally:
        if not args.keep:
            if rule:
                api("/alerts/rules/" + rule["id"], method="DELETE")
            for table in selected:
                api("/catalog/tables/" + table["id"],
                    {"alert_group_id": table.get("alert_group_id", "")}, "PUT")
            for group in groups:
                api("/alerts/groups/" + group["id"], method="DELETE")
            if channel:
                api("/notify/channels/" + channel["id"], method="DELETE")
        server.shutdown()


if __name__ == "__main__":
    main()
