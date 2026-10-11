import json
import os
from lightmoni import Client, TraceContext

endpoint = os.getenv("LIGHTMONI_ENDPOINT", "http://127.0.0.1:4318")
mode = os.getenv("LIGHTMONI_TEST_MODE", "demo")
limits = {"cardinality_limit": 2} if mode == "overflow" else {"queue_bytes": 1024, "max_batch_bytes": 1024, "buffer_bytes": 64} if mode == "capacity" else {}
mon = Client(os.getenv("LIGHTMONI_SERVICE", "example-python-api"), "http", endpoint, os.getenv("LIGHTMONI_KEY", ""), **limits)
counter = mon.counter("http.requests")
if mode == "fixture":
    dims = {"route": "/payments", "method": "POST", "status": 200}
    counter.add(1, dims)
    dims["status"] = 999
    counter.add(2, {"status": 200, "method": "POST", "route": "/payments"})
    counter.add(1, {"status": 500, "method": "POST", "route": "/payments"})
    counter.add(1, {"typed": 1})
    counter.add(1, {"typed": "1"})
    counter.add(-1)
    mon.counter("exact").add(9007199254740993)
    gauge = mon.gauge("active")
    gauge.record(5)
    gauge.record(7)
    histogram = mon.histogram("duration", boundaries=[5, 10])
    for n in [-1, 5, 6, 10, 11]:
        histogram.record(n)
    parent = TraceContext.extract({"traceparent": "00-" + "a" * 32 + "-" + "b" * 16 + "-01", "tracestate": "foo=bar"})
    assert TraceContext.extract({"traceparent": "00-" + "0" * 32 + "-" + "b" * 16 + "-01"}) is None
    assert TraceContext.extract(parent.inject()) == parent
    app = mon.with_table("app")
    with app.start_span("fixture", parent=parent) as span:
        app.log("info", "中文 fixture", {"exact": 9007199254740993, "ok": True, "fraction": .125}, span.context)
    mon.flush()
    counter.add(2, {"window": "next"})
    mon.flush()
elif mode == "overflow":
    for n in range(4):
        counter.add(1, {"dimension": n})
    mon.flush()
elif mode in ("retry", "auth"):
    counter.add(1, {"window": "first"})
    try:
        mon.flush(timeout=.45)
        raise AssertionError("expected deadline")
    except TimeoutError:
        pass
    assert mon.stats()["pending_batches"] == 1
    counter.add(2, {"window": "next"})
    mon.update_key("rotated")
    mon.flush()
elif mode in ("permanent", "partial", "capacity"):
    counter.add(1)
    for _ in range(2):
        try:
            mon.flush()
            raise AssertionError("expected delivery loss")
        except RuntimeError:
            pass
    assert mon.stats()["pending_batches"] == 0
else:
    app = mon.with_table("app")
    duration = mon.histogram("http.duration", boundaries=[5, 10, 25, 50, 100, 250])
    active = mon.gauge("http.active")
    for i in range(int(os.getenv("LIGHTMONI_COUNT", "20"))):
        status = 500 if i % 5 == 0 else 200
        with app.start_span("POST /payments") as span:
            dims = {"route": "/payments", "method": "POST", "status": status}
            counter.add(1, dims)
            duration.record(5 + i * 2, dims)
            active.record(i % 4)
            app.log("error" if status == 500 else "info", "sample payment completed", {"sample_id": i, "status": status})
            if status == 500:
                span.set_error("sample payment failed")
    mon.shutdown(timeout=15)
print(json.dumps(mon.stats()))
