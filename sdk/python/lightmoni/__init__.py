"""LightMoni native Python SDK. Recording never performs network I/O."""
import bisect
import contextvars
from contextlib import contextmanager
import datetime
import email.utils
import http.client
import json
import math
import random
import re
import threading
import time
import urllib.parse
import uuid
import weakref
import os
from dataclasses import dataclass
from .sampling import SYSTEM_TABLES, copy_policies, decode_config, matches, sample_log
from .transport import Request, ResponseTooLarge

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

    @staticmethod
    def current():
        return _context.get()

    @staticmethod
    def inject_current():
        context = _context.get()
        return context.inject() if context else {}

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


@contextmanager
def with_trace(context):
    """Bind incoming/captured context; contextvars isolates async tasks."""
    if not isinstance(context, TraceContext):
        raise ValueError("invalid trace context")
    token = _context.set(context)
    try:
        yield context
    finally:
        _context.reset(token)


def _endpoint(value):
    url = urllib.parse.urlsplit(value)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("valid HTTP(S) endpoint required")
    # Validate the port before any background work.
    url.port
    return value.rstrip("/")


def _secret(explicit, file_path, env_name, file_env_name, label):
    """Resolve one secret without ever logging its content."""
    file_path = file_path or os.environ.get(file_env_name, "")
    file_value = ""
    if file_path:
        try:
            if os.path.islink(file_path) or not os.path.isfile(file_path):
                raise ValueError(f"{label} file must be a regular file")
            with open(file_path, "rb") as fh:
                raw = fh.read(16 * 1024 + 1)
            if len(raw) > 16 * 1024:
                raise ValueError(f"{label} file is too large")
            file_value = raw.decode("utf-8").removesuffix("\n").removesuffix("\r")
        except (OSError, UnicodeDecodeError) as exc:
            raise ValueError(f"{label} file unavailable") from exc
    env_value = os.environ.get(env_name, "")
    values = [v for v in (explicit, file_value, env_value) if v]
    if len(set(values)) > 1:
        raise ValueError(f"credential_source_conflict: {env_name}")
    return (explicit or file_value or env_value), ("explicit" if explicit else "file" if file_value else "env" if env_value else "")


def _select_connection(mode, endpoint, key, agent_endpoint, local_token, timeout):
    mode = mode or "direct"
    if mode not in ("agent", "direct", "auto"):
        raise ValueError("mode must be agent, direct, or auto")
    if mode == "agent":
        return _endpoint(agent_endpoint or "http://127.0.0.1:4318"), local_token, "agent", "configured", ""
    if mode == "direct":
        if not endpoint:
            raise ValueError("direct mode requires endpoint")
        if not key:
            raise ValueError("direct mode requires data key")
        return _endpoint(endpoint), key, "direct", "not_probed", ""
    agent_endpoint = _endpoint(agent_endpoint or "http://127.0.0.1:4318")
    try:
        request = Request(agent_endpoint + "/healthz", time.monotonic() + min(max(float(timeout), .05), 2.0))
        status, _headers, _body = request.exchange("GET", maximum=1024)
        if 200 <= status < 300:
            return agent_endpoint, local_token, "agent", "healthy", ""
        # A response proves the endpoint exists; auth/protocol failures must
        # not be hidden by an automatic direct fallback.
        raise ValueError(f"agent probe HTTP {status}")
    except (OSError, TimeoutError):
        pass
    if not endpoint or not key:
        raise ValueError("auto_route_unavailable: agent unavailable and direct credentials are missing")
    return _endpoint(endpoint), key, "direct", "unavailable_fallback", "agent_unreachable_before_body"


class _State:
    def __init__(self, service, endpoint, key, limits, resource=None, instance_id=None):
        if not isinstance(service, str) or not service or len(service.encode()) > 128:
            raise ValueError("valid service and HTTP(S) endpoint required")
        self.endpoint, self.key, self.service = _endpoint(endpoint), key, service
        self.limits = dict(queue_bytes=8 << 20, queue_batches=256, buffer_bytes=8 << 20,
                           max_batch_bytes=1 << 20, cardinality_limit=2000, max_instruments=256)
        if limits.keys() - self.limits.keys():
            raise ValueError("unknown SDK limit")
        self.limits.update(limits)
        if any(type(n) is not int or n <= 0 for n in self.limits.values()) or self.limits["max_batch_bytes"] > self.limits["queue_bytes"]:
            raise ValueError("invalid SDK limits")
        self.lock, self.delivery = threading.RLock(), threading.Lock()
        self.closed, self.closing, self.failure, self.sequence = False, False, None, 0
        if instance_id is not None and (not isinstance(instance_id, str) or not instance_id or len(instance_id.encode()) > 128):
            raise ValueError("invalid instance ID")
        self.instance = instance_id if instance_id is not None else str(uuid.uuid4())
        resource = dict(resource or {})
        if "service.name" in resource or "service.instance.id" in resource:
            raise ValueError("configure service identity separately")
        custom = _attrs(resource)
        self.resource_values = dict(resource, **{"service.name": service, "service.instance.id": self.instance})
        self.resource = {"attributes": custom + _attrs({"service.name": service, "service.instance.id": self.instance})}
        self.metrics, self.records, self.queue = {}, {}, []
        self.stats = dict(pending_batches=0, pending_bytes=0, buffer_bytes=0, delivered_batches=0,
                          retried_batches=0, invalid_records=0, overflow_records=0,
                          dropped_records=0, rejected_records=0, last_error="", sampled_out_logs=0,
                          unmatched_logs=0, excluded_logs=0, disabled_records=0, reporting_disabled=False,
                          config_revision="", config_error="", configured_mode="", selected_route="",
                          agent_probe="", fallback_count=0, last_route_error="", route_uncertain=False,
                          credential_source="")
        self.local_sampling, self.remote_sampling = {}, {}
        self.local_disabled, self.remote_disabled, self.reporting_disabled = False, False, False
        self.reporting_generation, self.source_sequence = 0, 0
        self.delivery_abort = threading.Event()
        self.active_request, self.config_request = None, None
        self.config_lock = threading.Lock()
        self.config_worker, self.heartbeat_worker = None, None
        self.shutdown_done, self.shutdown_failure = threading.Event(), None
        self.self_enabled, self.self_table, self.self_last, self.self_started = True, "", float("-inf"), False
        self.self_previous = {}
        self.stop = threading.Event()

    def set_disabled(self, disabled):
        """Under the state lock; return the HTTP handle to cancel outside it."""
        if self.reporting_disabled == disabled:
            return None
        self.reporting_disabled = self.stats["reporting_disabled"] = disabled
        active = None
        if disabled:
            self.reporting_generation += 1
            self.delivery_abort.set()
            active = self.active_request
            self.stats["disabled_records"] += sum(len(rows) for rows in self.records.values()) + sum(item[6] for item in self.queue)
            for metric in self.metrics.values():
                self.stats["disabled_records"] += len(metric.series)
                metric.series.clear()
                metric.start = time.time_ns()
            self.records.clear()
            self.queue.clear()
            self.stats["buffer_bytes"] = self.stats["pending_bytes"] = self.stats["pending_batches"] = 0
        else:
            self.delivery_abort = threading.Event()
            self.self_last = float("-inf")
            for metric in self.metrics.values():
                metric.start = time.time_ns()
        return active

    def sampling_record(self, severity="", context=None):
        return {"service": self.service, "instance_id": self.instance, "sdk.language": "python",
                "severity": severity.upper(), "trace_id": context.trace_id if context else None,
                "event_id": self.instance + ":" + str(self.source_sequence)}

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
            if self.closed or self.closing:
                self.invalid("record after shutdown")
            elif self.reporting_disabled:
                self.stats["disabled_records"] += 1
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
        if self.reporting_disabled:
            return
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
        if self.reporting_disabled or not self.self_enabled or time.monotonic() - self.self_last < 30:
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
                if s.closed or s.closing:
                    raise ValueError("metric after shutdown")
                if s.reporting_disabled:
                    s.stats["disabled_records"] += 1
                    return
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
        self.reporting_generation = client._state.reporting_generation
        self.suppressed = client._state.reporting_disabled
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
                if self.suppressed or self.reporting_generation != self.client._state.reporting_generation:
                    self.client._state.stats["disabled_records"] += 1
                    return
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
    @classmethod
    def from_env(cls, service, table, **kwargs):
        """Build a client from LIGHTMONI_* variables and optional explicit fields."""
        mode = kwargs.pop("mode", os.environ.get("LIGHTMONI_MODE", "direct"))
        if mode not in ("agent", "direct", "auto"):
            raise ValueError("mode must be agent, direct, or auto")
        explicit_endpoint = kwargs.pop("endpoint", "")
        explicit_agent = kwargs.pop("agent_endpoint", "")
        explicit_local, local_file = kwargs.pop("local_token", ""), kwargs.pop("local_token_file", "")
        explicit_data, data_file = kwargs.pop("data_key", kwargs.pop("key", "")), kwargs.pop("data_key_file", "")
        endpoint = "" if mode == "agent" else explicit_endpoint or os.environ.get("LIGHTMONI_ENDPOINT", "")
        agent_endpoint = "" if mode == "direct" else explicit_agent or os.environ.get("LIGHTMONI_AGENT_ENDPOINT", "")
        local_token = local_source = data_key = data_source = ""
        if mode != "direct":
            local_token, local_source = _secret(explicit_local, local_file, "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE", "local token")
        if mode != "agent":
            data_key, data_source = _secret(explicit_data, data_file, "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE", "data key")
            legacy_key, legacy_source = _secret("", "", "LIGHTMONI_KEY", "", "legacy data key")
            if data_key and legacy_key and data_key != legacy_key:
                raise ValueError("credential_source_conflict: LIGHTMONI_KEY")
            if not data_key:
                data_key, data_source = legacy_key, ("legacy-env" if legacy_key else legacy_source)
        selected_endpoint, selected_key, selected_route, probe, fallback = _select_connection(mode, endpoint, data_key, agent_endpoint, local_token, kwargs.pop("discovery_timeout", .5))
        client = cls(service, table, endpoint=selected_endpoint, key=selected_key, mode=mode, **kwargs)
        client._state.stats.update(configured_mode=mode, selected_route=selected_route, agent_probe=probe, credential_source=local_source if selected_route == "agent" else data_source)
        if fallback:
            client._state.stats["fallback_count"] += 1
        return client

    def __init__(self, service, table, endpoint="http://127.0.0.1:4318", key="", self_telemetry=True, *,
                 log_sampling=None, disabled=False, remote_config=True, config_endpoint=None, config_key=None,
                 config_interval=30, resource=None, instance_id=None, mode="direct", **limits):
        if type(disabled) is not bool or type(remote_config) is not bool:
            raise ValueError("reporting switches require booleans")
        if type(config_interval) not in (int, float) or not math.isfinite(config_interval) or config_interval < 1:
            raise ValueError("configuration interval must be at least one second")
        policies = copy_policies({} if log_sampling is None else log_sampling)
        config_url = _endpoint(endpoint if mode == "agent" else config_endpoint if config_endpoint is not None else endpoint)
        self.table, self._state = _table(table), _State(service, endpoint, key, limits, resource, instance_id)
        self._state.stats.update(configured_mode=mode, selected_route="agent" if mode == "agent" else "direct", agent_probe="configured", credential_source="explicit")
        self._state.local_sampling = policies
        self._state.local_disabled = disabled
        self._state.set_disabled(disabled)
        self._state.remote_config, self._state.config_endpoint = remote_config, config_url
        self._state.config_key, self._state.config_interval = (None if mode == "agent" else config_key), config_interval
        self._state.self_enabled, self._state.self_table = bool(self_telemetry), self.table
        if self_telemetry:
            reference, stop, table = weakref.ref(self._state), self._state.stop, self.table
            def heartbeat():
                while not stop.wait(30):
                    state = reference()
                    if state is None or state.closed or state.closing:
                        return
                    client = object.__new__(Client)
                    client._state, client.table = state, table
                    try:
                        client.flush(timeout=5)
                    except (OSError, ValueError, RuntimeError):
                        pass
                    del client, state
            self._state.heartbeat_worker = threading.Thread(target=heartbeat, name="lightmoni-heartbeat", daemon=True)
            self._state.heartbeat_worker.start()
        if remote_config:
            reference, stop, table = weakref.ref(self._state), self._state.stop, self.table
            def configuration():
                while not stop.wait(config_interval):
                    state = reference()
                    if state is None or state.closed or state.closing:
                        return
                    client = object.__new__(Client)
                    client._state, client.table = state, table
                    try:
                        client.refresh_config()
                    except (OSError, ValueError, RuntimeError):
                        pass
                    del client, state
            self._state.config_worker = threading.Thread(target=configuration, name="lightmoni-config", daemon=True)
            self._state.config_worker.start()

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
            if s.closed or s.closing:
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
            values = dict(attributes or {})
            encoded = _attrs(values)
            now = str(time.time_ns())
            row = dict(timeUnixNano=now, observedTimeUnixNano=now, severityText=level,
                       severityNumber={"trace": 1, "debug": 5, "info": 9, "warn": 13, "error": 17, "fatal": 21}[level],
                       body={"stringValue": body}, attributes=encoded)
            if context:
                row.update(traceId=context.trace_id, spanId=context.span_id, flags=context.flags)
            with s.lock:
                if s.closed or s.closing:
                    s.invalid("log after shutdown")
                    return
                if s.reporting_disabled:
                    s.stats["disabled_records"] += 1
                    return
                s.source_sequence += 1
                policy = s.remote_sampling.get(self.table, s.local_sampling.get(self.table))
                if policy is not None and self.table not in SYSTEM_TABLES:
                    keep, rate, reason = sample_log(policy, self.table, s.sampling_record(level, context), values, s.resource_values)
                    if not keep:
                        counter = "excluded_logs" if reason == "excluded" else "unmatched_logs" if reason == "unmatched" else "sampled_out_logs"
                        s.stats[counter] += 1
                        return
                    metadata = {"lightmoni.sampling.rate": float(rate), "lightmoni.sampling.weight": 1 / rate,
                                "lightmoni.sampling.rule": reason, "lightmoni.source_id": s.instance,
                                "lightmoni.source_seq": s.source_sequence}
                    row["attributes"] = [a for a in encoded if a["key"] not in metadata] + _attrs(metadata)
                s.store(self.table, "logs", row)
        except (ValueError, TypeError) as error:
            with s.lock:
                s.invalid(error)

    def start_span(self, name, attributes=None, parent=None):
        with self._state.lock:
            if self._state.closed or self._state.closing:
                raise RuntimeError("SDK is closed")
            return Span(self, name, attributes or {}, parent or _context.get())

    def stats(self):
        with self._state.lock:
            return dict(self._state.stats)

    def update_key(self, key):
        with self._state.lock:
            self._state.key = key

    def update_log_sampling(self, policies):
        snapshot = copy_policies(policies)
        with self._state.lock:
            if self._state.closed or self._state.closing:
                raise RuntimeError("SDK is closed")
            self._state.local_sampling = snapshot

    def set_reporting_enabled(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("reporting switch requires a boolean")
        s = self._state
        with s.lock:
            if s.closed or s.closing:
                raise RuntimeError("SDK is closed")
            s.local_disabled = not enabled
            active = s.set_disabled(s.local_disabled or s.remote_disabled)
        if active is not None:
            active.cancel()

    def refresh_config(self, timeout=5):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive")
        s, deadline = self._state, time.monotonic() + min(timeout, 5)
        acquired, request = False, None
        try:
            acquired = s.config_lock.acquire(timeout=max(0, deadline - time.monotonic()))
            if not acquired:
                raise TimeoutError("SDK configuration deadline exceeded")
            with s.lock:
                if not s.remote_config or s.closed or s.closing:
                    raise RuntimeError("SDK configuration disabled or closed")
                key = s.key if s.config_key is None else s.config_key
                request = Request(s.config_endpoint + "/v1/sdk-config", deadline)
                s.config_request = request
            headers = {"Authorization": "Bearer " + key} if key else {}
            status, _headers, raw = request.exchange("GET", headers=headers, maximum=1 << 20)
            if status != 200:
                raise RuntimeError("SDK configuration HTTP " + str(status))
            snapshot = decode_config(raw)
            if time.monotonic() >= deadline:
                raise TimeoutError("SDK configuration deadline exceeded")
            with s.lock:
                if s.closed or s.closing:
                    raise RuntimeError("SDK configuration disabled or closed")
                s.remote_sampling = snapshot["log_sampling"]
                s.remote_disabled = any(matches(rule["conditions"], s.sampling_record(), {}, s.resource_values)
                                        for rule in snapshot["disable_rules"])
                active = s.set_disabled(s.local_disabled or s.remote_disabled)
                s.stats["config_revision"], s.stats["config_error"] = snapshot["revision"], ""
            if active is not None:
                active.cancel()
        except (OSError, ValueError, RuntimeError, OverflowError, RecursionError, http.client.HTTPException) as error:
            message = str(error) if isinstance(error, RuntimeError) and str(error).startswith("SDK configuration") else "SDK configuration unavailable or invalid"
            with s.lock:
                if not s.closing and not s.closed:
                    s.stats["config_error"] = message
            raise RuntimeError(message) from None
        finally:
            if request is not None:
                with s.lock:
                    if s.config_request is request:
                        s.config_request = None
            if acquired:
                s.config_lock.release()

    def flush(self, timeout=10):
        return self._flush(timeout)

    def _flush(self, timeout, allow_closing=False):
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive")
        s, deadline = self._state, time.monotonic() + timeout
        if not s.delivery.acquire(timeout=timeout):
            raise TimeoutError("flush deadline exceeded")
        try:
            with s.lock:
                if s.closed or s.closing and not allow_closing:
                    raise RuntimeError("SDK is closed")
                if s.reporting_disabled:
                    return
                generation, abort = s.reporting_generation, s.delivery_abort
                s.collect()
                target = s.sequence
            backoff = .2
            while True:
                with s.lock:
                    if generation != s.reporting_generation or abort.is_set():
                        return
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
                request = Request(s.endpoint + "/v1/" + signal, min(deadline, time.monotonic() + 10))
                with s.lock:
                    if generation != s.reporting_generation or abort.is_set():
                        return
                    s.active_request = request
                try:
                    response_status, response_headers, body = request.exchange("POST", payload, headers)
                    if 200 <= response_status < 300:
                        result = json.loads(body or b"{}")
                        if not isinstance(result, dict):
                            raise ValueError("invalid acknowledgment")
                        partial = result.get("partialSuccess") or {}
                        if not isinstance(partial, dict):
                            raise ValueError("invalid partial success")
                        rejected = int(partial.get({"logs": "rejectedLogRecords", "metrics": "rejectedDataPoints", "traces": "rejectedSpans"}[signal], 0))
                        acknowledged = True
                    else:
                        status = response_status
                    raw = response_headers.get("Retry-After", "")
                    try:
                        retry_after = max(0, float(raw)) if raw.isdigit() else max(0, email.utils.parsedate_to_datetime(raw).timestamp() - time.time())
                    except (ValueError, TypeError, OverflowError):
                        pass
                except ResponseTooLarge:
                    status = 413
                except (OSError, ValueError, http.client.HTTPException):
                    pass
                finally:
                    with s.lock:
                        if s.active_request is request:
                            s.active_request = None
                with s.lock:
                    if generation != s.reporting_generation or abort.is_set():
                        return
                    if not s.queue or s.queue[0] is not item:
                        raise RuntimeError("SDK queue changed during delivery")
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
                abort.wait(min(delay, max(0, deadline - time.monotonic())))
                backoff = min(30, backoff * 2)
        finally:
            s.delivery.release()

    def shutdown(self, timeout=10):
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive")
        s, deadline = self._state, time.monotonic() + timeout
        with s.lock:
            waiting = s.closing or s.closed
            if not waiting:
                s.closing = True
                s.stop.set()
                s.delivery_abort.set()
                s.delivery_abort = threading.Event()
                requests = (s.active_request, s.config_request)
        if waiting:
            if not s.shutdown_done.wait(max(0, deadline - time.monotonic())):
                raise TimeoutError("SDK shutdown deadline exceeded")
            with s.lock:
                failure = s.shutdown_failure
            if failure is not None:
                raise RuntimeError("SDK shutdown failed: " + str(failure)) from None
            return
        for request in requests:
            if request is not None:
                request.cancel()
        failure = None
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("SDK shutdown deadline exceeded")
            self._flush(remaining, allow_closing=True)
        except BaseException as error:
            failure = error
            raise
        finally:
            with s.lock:
                s.closed, s.shutdown_failure = True, failure
                s.shutdown_done.set()
