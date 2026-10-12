"""LightMoni native Python SDK. Recording never performs network I/O."""
import bisect
import contextvars
import datetime
import email.utils
import json
import math
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import weakref
from dataclasses import dataclass

_context = contextvars.ContextVar("lightmoni_trace", default=None)
_MAX_INT = (1 << 63) - 1
_DEFAULT_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000]


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def _table(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", value) or value.startswith(("log_", "metric_", "trace_")):
        raise ValueError("invalid logical table")
    return value


def _attrs(values):
    if len(values) > 32:
        raise ValueError("attribute count exceeded")
    result = []
    for key in sorted(values):
        if not isinstance(key, str) or not key or len(key.encode()) > 128:
            raise ValueError("invalid attribute key")
        value = values[key]
        if isinstance(value, bool):
            item = {"boolValue": value}
        elif isinstance(value, int) and -1 << 63 <= value <= _MAX_INT:
            item = {"intValue": str(value)}
        elif isinstance(value, float) and math.isfinite(value):
            item = {"doubleValue": value}
        elif isinstance(value, str):
            item = {"stringValue": value}
        else:
            raise ValueError("attributes require string/bool/Int64/finite float")
        result.append({"key": key, "value": item})
    if len(_json(result)) > 4096:
        raise ValueError("attribute bytes exceeded")
    return result


@dataclass(frozen=True)
class TraceContext:
    trace_id: str
    span_id: str
    flags: int = 1
    trace_state: str = ""

    def __post_init__(self):
        if (not re.fullmatch(r"[0-9a-f]{32}", self.trace_id) or int(self.trace_id, 16) == 0
                or not re.fullmatch(r"[0-9a-f]{16}", self.span_id) or int(self.span_id, 16) == 0
                or type(self.flags) is not int or not 0 <= self.flags <= 255 or len(self.trace_state) > 512):
            raise ValueError("invalid trace context")

    def inject(self):
        headers = {"traceparent": f"00-{self.trace_id}-{self.span_id}-{self.flags:02x}"}
        if self.trace_state:
            headers["tracestate"] = self.trace_state
        return headers

    @classmethod
    def extract(cls, headers):
        headers = {k.lower(): v for k, v in headers.items()}
        match = re.fullmatch(r"00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})", headers.get("traceparent", ""))
        if not match:
            return None
        try:
            return cls(match[1], match[2], int(match[3], 16), headers.get("tracestate", ""))
        except ValueError:
            return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class _State:
    def __init__(self, service, endpoint, key, limits):
        url = urllib.parse.urlsplit(endpoint)
        if not service or len(service.encode()) > 128 or url.scheme not in ("http", "https") or not url.hostname or url.username or url.query or url.fragment:
            raise ValueError("valid service and HTTP(S) endpoint required")
        self.endpoint, self.key = endpoint.rstrip("/"), key
        self.limits = dict(queue_bytes=8 << 20, queue_batches=256, buffer_bytes=8 << 20,
                           max_batch_bytes=1 << 20, cardinality_limit=2000, max_instruments=256)
        if limits.keys() - self.limits.keys():
            raise ValueError("unknown SDK limit")
        self.limits.update(limits)
        if any(type(n) is not int or n <= 0 for n in self.limits.values()) or self.limits["max_batch_bytes"] > self.limits["queue_bytes"]:
            raise ValueError("invalid SDK limits")
        self.lock, self.delivery = threading.RLock(), threading.Lock()
        self.closed, self.failure, self.sequence = False, None, 0
        self.instance = str(uuid.uuid4())
        self.resource = {"attributes": _attrs({"service.name": service, "service.instance.id": self.instance})}
        self.metrics, self.records, self.queue = {}, {}, []
        self.stats = dict(pending_batches=0, pending_bytes=0, buffer_bytes=0, delivered_batches=0,
                          retried_batches=0, invalid_records=0, overflow_records=0,
                          dropped_records=0, rejected_records=0, last_error="")
        self.opener = urllib.request.build_opener(_NoRedirect())
        self.self_enabled, self.self_table, self.self_last, self.self_started = True, "", float("-inf"), False
        self.self_previous = {}
        self.stop = threading.Event()

    def invalid(self, message):
        self.stats["invalid_records"] += 1
        self.stats["last_error"] = str(message)

    def lost(self, count, message):
        self.stats["dropped_records"] += count
        self.failure = message
        self.stats["last_error"] = message

    def reserve(self, size):
        if self.stats["buffer_bytes"] + size > self.limits["buffer_bytes"]:
            self.lost(1, "SDK active buffer exceeded")
            return False
        self.stats["buffer_bytes"] += size
        return True

    def store(self, table, signal, record):
        with self.lock:
            if self.closed:
                self.invalid("record after shutdown")
            elif self.reserve(len(_json(record)) + 64):
                self.records.setdefault((table, signal), []).append(record)

    def payload(self, signal, records):
        if signal == "metrics":
            merged = {}
            for record in records:
                kind = next(k for k in ("sum", "gauge", "histogram") if k in record)
                if record["name"] not in merged:
                    merged[record["name"]] = dict(record, **{kind: dict(record[kind], dataPoints=list(record[kind]["dataPoints"]))})
                else:
                    merged[record["name"]][kind]["dataPoints"].extend(record[kind]["dataPoints"])
            records = list(merged.values())
        resource, scope, field = {"metrics": ("resourceMetrics", "scopeMetrics", "metrics"),
                                  "logs": ("resourceLogs", "scopeLogs", "logRecords"),
                                  "traces": ("resourceSpans", "scopeSpans", "spans")}[signal]
        return _json({resource: [{"resource": self.resource, scope: [{
            "scope": {"name": "lightmoni/sdk/python", "version": "0.1.0"}, field: records}]}]})

    def collect(self):
        now = time.time_ns()
        for metric in self.metrics.values():
            end = max(now, metric.start)
            for point in metric.series.values():
                row = {"attributes": point["attrs"], "timeUnixNano": str(point["at"] if metric.kind == "gauge" else end)}
                record = {"name": metric.name, "unit": metric.unit}
                if metric.kind == "counter":
                    row.update(startTimeUnixNano=str(metric.start), asInt=str(point["value"]))
                    record["sum"] = {"dataPoints": [row], "aggregationTemporality": 1, "isMonotonic": True}
                elif metric.kind == "gauge":
                    row["asDouble"] = point["value"]
                    record["gauge"] = {"dataPoints": [row]}
                else:
                    row.update(startTimeUnixNano=str(metric.start), count=str(point["count"]),
                               sum=point["value"], explicitBounds=metric.bounds,
                               bucketCounts=[str(n) for n in point["buckets"]], min=point["min"], max=point["max"])
                    record["histogram"] = {"dataPoints": [row], "aggregationTemporality": 1}
                self.records.setdefault((metric.table, "metrics"), []).append(record)
            metric.series.clear()
            metric.start = end
        at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        for (table, signal), records in sorted(self.records.items()):
            group = []
            size = len(self.payload(signal, []))
            for record in records:
                cost = len(_json(record)) + 1
                if group and size + cost > self.limits["max_batch_bytes"]:
                    self.enqueue(table, signal, group, at)
                    group, size = [], len(self.payload(signal, []))
                group.append(record)
                size += cost
            if group:
                self.enqueue(table, signal, group, at)
        self.records.clear()
        self.stats["buffer_bytes"] = 0
        self.collect_self()

    def enqueue(self, table, signal, records, at):
        payload = self.payload(signal, records)
        self.sequence += 1
        if (len(payload) > self.limits["max_batch_bytes"] or len(self.queue) >= self.limits["queue_batches"]
                or self.stats["pending_bytes"] + len(payload) > self.limits["queue_bytes"]):
            self.lost(len(records), "SDK queue or batch capacity exceeded")
            return
        self.queue.append((self.sequence, str(uuid.uuid4()), at, table, signal, payload, len(records)))
        self.stats["pending_bytes"] += len(payload)
        self.stats["pending_batches"] += 1

    def enqueue_self(self, signal, rows, at):
        size = len(self.payload(signal, rows))
        if size > self.limits['max_batch_bytes'] or len(self.queue) >= self.limits['queue_batches'] or self.stats['pending_bytes'] + size > self.limits['queue_bytes']:
            return False
        self.enqueue(self.self_table, signal, rows, at)
        return True

    def collect_self(self):
        if not self.self_enabled or time.monotonic() - self.self_last < 30:
            return
        self.self_last = time.monotonic()
        at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        now = str(time.time_ns())
        attributes = _attrs({'lightmoni.component': 'sdk', 'sdk.language': 'python', 'sdk.version': '0.1.0'})
        values = dict(heartbeat=1, **{n: self.stats[n] for n in ('pending_batches','pending_bytes','retried_batches','dropped_records','rejected_records','invalid_records','overflow_records')})
        self.enqueue_self('metrics', [dict(name='lightmoni.sdk.' + name, gauge={'dataPoints': [dict(timeUnixNano=now, asDouble=value, attributes=attributes)]}) for name,value in values.items()], at)
        changed = any(self.stats[n] > self.self_previous.get(n, 0) for n in ('retried_batches','dropped_records','rejected_records','invalid_records','overflow_records'))
        if not self.self_started or changed:
            event = 'diagnostics_changed' if self.self_started else 'started'
            row = dict(timeUnixNano=now, severityText='WARN' if changed else 'INFO', severityNumber=13 if changed else 9, body={'stringValue': 'LightMoni SDK delivery, buffer or input diagnostics changed' if changed else 'LightMoni SDK started'}, attributes=attributes + _attrs({'event': event}))
            if self.enqueue_self('logs', [row], at):
                self.self_started, self.self_previous = True, dict(self.stats)



class Metric:
    def __init__(self, state, table, name, kind, unit, bounds):
        self.state, self.table, self.name, self.kind, self.unit, self.bounds = state, table, name, kind, unit, bounds
        self.start, self.series = time.time_ns(), {}

    def add(self, value=1, attributes=None):
        if self.kind != "counter":
            raise ValueError("add requires a counter")
        self.record(value, attributes)

    def record(self, value, attributes=None):
        s = self.state
        with s.lock:
            try:
                if s.closed:
                    raise ValueError("metric after shutdown")
                if self.kind == "counter":
                    if type(value) is not int or not 0 <= value <= _MAX_INT:
                        raise ValueError("counter requires nonnegative Int64")
                elif type(value) not in (int, float) or not math.isfinite(value):
                    raise ValueError("metric requires finite number")
                attrs = _attrs(attributes or {})
                key = _json(attrs)
                if key not in self.series and len(self.series) >= s.limits["cardinality_limit"]:
                    key, attrs = b"overflow", _attrs({"otel.metric.overflow": True})
                    s.stats["overflow_records"] += 1
                p = self.series.get(key)
                if p is None:
                    if not s.reserve(len(key) + 160 + 8 * (len(self.bounds) + 1)):
                        return
                    p = dict(attrs=attrs, value=0, count=0, buckets=[0] * (len(self.bounds) + 1), min=value, max=value, at=0)
                    self.series[key] = p
                if self.kind == "counter":
                    if p["value"] + value > _MAX_INT:
                        raise ValueError("counter overflow")
                    p["value"] += value
                elif self.kind == "gauge":
                    p["value"] = float(value)
                else:
                    if not math.isfinite(p["value"] + value) or p["count"] >= _MAX_INT:
                        raise ValueError("histogram overflow")
                    p["value"] += float(value)
                    p["count"] += 1
                    p["buckets"][bisect.bisect_left(self.bounds, value)] += 1
                    p["min"], p["max"] = min(p["min"], value), max(p["max"], value)
                p["at"] = time.time_ns()
            except (ValueError, TypeError, OverflowError) as error:
                s.invalid(error)


class Span:
    def __init__(self, client, name, attributes, parent):
        if not name or len(name.encode()) > 255:
            raise ValueError("invalid span name")
        self.client, self.ended = client, False
        self.context = TraceContext(parent.trace_id if parent else uuid.uuid4().hex, uuid.uuid4().hex[:16],
                                    parent.flags if parent else 1, parent.trace_state if parent else "")
        self.data = dict(name=name, kind=1, traceId=self.context.trace_id, spanId=self.context.span_id,
                         flags=self.context.flags, startTimeUnixNano=str(time.time_ns()), attributes=_attrs(attributes))
        if parent:
            self.data["parentSpanId"] = parent.span_id
            if parent.trace_state:
                self.data["traceState"] = parent.trace_state

    def set_error(self, message):
        with self.client._state.lock:
            if not self.ended:
                self.data["status"] = {"code": 2, "message": str(message)[:4096]}

    def end(self):
        with self.client._state.lock:
            if not self.ended:
                self.ended = True
                self.data["endTimeUnixNano"] = str(max(time.time_ns(), int(self.data["startTimeUnixNano"])))
                self.client._state.store(self.client.table, "traces", self.data)

    def __enter__(self):
        self.token = _context.set(self.context)
        return self

    def __exit__(self, kind, error, traceback):
        if error:
            self.set_error(error)
        _context.reset(self.token)
        self.end()


class Client:
    def __init__(self, service, table, endpoint="http://127.0.0.1:4318", key="", self_telemetry=True, **limits):
        self.table, self._state = _table(table), _State(service, endpoint, key, limits)
        self._state.self_enabled, self._state.self_table = bool(self_telemetry), self.table
        if self_telemetry:
            reference, stop, table = weakref.ref(self._state), self._state.stop, self.table
            def heartbeat():
                while not stop.wait(30):
                    state = reference()
                    if state is None or state.closed:
                        return
                    client = object.__new__(Client)
                    client._state, client.table = state, table
                    try:
                        client.flush(timeout=5)
                    except (OSError, ValueError, RuntimeError):
                        pass
                    del client, state
            threading.Thread(target=heartbeat, name="lightmoni-heartbeat", daemon=True).start()

    def with_table(self, table):
        child = object.__new__(Client)
        child.table, child._state = _table(table), self._state
        return child

    def _metric(self, name, kind, unit="", boundaries=None):
        s = self._state
        bounds = list(_DEFAULT_BOUNDS if boundaries is None else boundaries) if kind == "histogram" else []
        if not name or len(name.encode()) > 255 or len(unit.encode()) > 64 or len(bounds) > 128 or any(not math.isfinite(n) or (i and bounds[i-1] >= n) for i, n in enumerate(bounds)):
            raise ValueError("invalid metric name/unit/boundaries")
        with s.lock:
            if s.closed:
                raise RuntimeError("SDK is closed")
            identity = (self.table, name)
            if identity in s.metrics:
                metric = s.metrics[identity]
                if (metric.kind, metric.unit, metric.bounds) != (kind, unit, bounds):
                    raise ValueError("conflicting metric registration")
                return metric
            if len(s.metrics) >= s.limits["max_instruments"]:
                raise ValueError("instrument limit exceeded")
            metric = Metric(s, self.table, name, kind, unit, bounds)
            s.metrics[identity] = metric
            return metric

    def counter(self, name, unit=""):
        return self._metric(name, "counter", unit)

    def gauge(self, name, unit=""):
        return self._metric(name, "gauge", unit)

    def histogram(self, name, unit="", boundaries=None):
        return self._metric(name, "histogram", unit, boundaries)

    def log(self, severity, body, attributes=None, context=None):
        s = self._state
        try:
            level = severity.lower()
            if level not in ("trace", "debug", "info", "warn", "error", "fatal") or not isinstance(body, str) or len(body.encode()) > 65536:
                raise ValueError("invalid log severity/body")
            context = context or _context.get()
            now = str(time.time_ns())
            row = dict(timeUnixNano=now, observedTimeUnixNano=now, severityText=level,
                       severityNumber={"trace": 1, "debug": 5, "info": 9, "warn": 13, "error": 17, "fatal": 21}[level],
                       body={"stringValue": body}, attributes=_attrs(attributes or {}))
            if context:
                row.update(traceId=context.trace_id, spanId=context.span_id, flags=context.flags)
            s.store(self.table, "logs", row)
        except (ValueError, TypeError) as error:
            with s.lock:
                s.invalid(error)

    def start_span(self, name, attributes=None, parent=None):
        with self._state.lock:
            if self._state.closed:
                raise RuntimeError("SDK is closed")
        return Span(self, name, attributes or {}, parent or _context.get())

    def stats(self):
        with self._state.lock:
            return dict(self._state.stats)

    def update_key(self, key):
        with self._state.lock:
            self._state.key = key

    def flush(self, timeout=10):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive")
        s, deadline = self._state, time.monotonic() + timeout
        if not s.delivery.acquire(timeout=timeout):
            raise TimeoutError("flush deadline exceeded")
        try:
            with s.lock:
                if s.closed:
                    raise RuntimeError("SDK is closed")
                s.collect()
                target = s.sequence
            backoff = .2
            while True:
                with s.lock:
                    if not s.queue or s.queue[0][0] > target:
                        if s.failure:
                            raise RuntimeError(s.failure)
                        return
                    item, key = s.queue[0], s.key
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("flush deadline exceeded; batches retained")
                seq, identity, created, table, signal, payload, count = item
                headers = {"Content-Type": "application/json", "X-Lightmoni-Table": table,
                           "X-Lightmoni-Batch-ID": identity, "X-Lightmoni-Batch-Created-At": created}
                if key:
                    headers["Authorization"] = "Bearer " + key
                status, retry_after, rejected, acknowledged = 0, 0, 0, False
                try:
                    request = urllib.request.Request(s.endpoint + "/v1/" + signal, payload, headers)
                    with s.opener.open(request, timeout=min(remaining, 10)) as response:
                        body = response.read(65537)
                        if len(body) > 65536:
                            status = 413
                        else:
                            result = json.loads(body or b"{}")
                            if not isinstance(result, dict):
                                raise ValueError("invalid acknowledgment")
                            partial = result.get("partialSuccess") or {}
                            if not isinstance(partial, dict):
                                raise ValueError("invalid partial success")
                            rejected = int(partial.get({"logs": "rejectedLogRecords", "metrics": "rejectedDataPoints", "traces": "rejectedSpans"}[signal], 0))
                            acknowledged = True
                except urllib.error.HTTPError as error:
                    status = error.code
                    raw = error.headers.get("Retry-After", "")
                    try:
                        retry_after = max(0, float(raw)) if raw.isdigit() else max(0, email.utils.parsedate_to_datetime(raw).timestamp() - time.time())
                    except (ValueError, TypeError, OverflowError):
                        pass
                    error.close()
                except (OSError, ValueError, urllib.error.URLError):
                    pass
                with s.lock:
                    if acknowledged or status not in (0, 401, 403, 429, 502, 503, 504):
                        s.queue.pop(0)
                        s.stats["pending_batches"] -= 1
                        s.stats["pending_bytes"] -= len(payload)
                        if acknowledged and not rejected:
                            s.stats["delivered_batches"] += 1
                        else:
                            s.stats["rejected_records"] += rejected or count
                            s.failure = "OTLP partial success; not retried" if acknowledged else f"telemetry rejected with HTTP {status}"
                            s.stats["last_error"] = s.failure
                        backoff = .2
                        continue
                    s.stats["retried_batches"] += 1
                    s.stats["last_error"] = f"telemetry delivery failed (HTTP {status})"
                delay = max(retry_after, 30 if status in (401, 403) else backoff * random.uniform(.8, 1.2))
                time.sleep(min(delay, max(0, deadline - time.monotonic())))
                backoff = min(30, backoff * 2)
        finally:
            s.delivery.release()

    def shutdown(self, timeout=10):
        self._state.stop.set()
        try:
            self.flush(timeout)
        finally:
            with self._state.lock:
                self._state.closed = True
