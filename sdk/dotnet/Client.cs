using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LightMoni;

public sealed record Limits(long QueueBytes = 8 << 20, int QueueBatches = 256, long BufferBytes = 8 << 20,
    int MaxBatchBytes = 1 << 20, int CardinalityLimit = 2000, int MaxInstruments = 256);

public sealed record TraceContext(string TraceId, string SpanId, byte Flags = 1, string TraceState = "")
{
    public bool IsValid => Regex.IsMatch(TraceId, "^[0-9a-f]{32}$") && TraceId != new string('0', 32)
        && Regex.IsMatch(SpanId, "^[0-9a-f]{16}$") && SpanId != new string('0', 16) && TraceState.Length <= 512;
    public Dictionary<string, string> Inject()
    {
        if (!IsValid) throw new ArgumentException("invalid trace context");
        var headers = new Dictionary<string, string> { ["traceparent"] = $"00-{TraceId}-{SpanId}-{Flags:x2}" };
        if (TraceState.Length > 0) headers["tracestate"] = TraceState;
        return headers;
    }
    public static TraceContext? Extract(IDictionary<string, string> headers)
    {
        var h = new Dictionary<string, string>(headers, StringComparer.OrdinalIgnoreCase);
        var p = h.GetValueOrDefault("traceparent", "");
        if (!Regex.IsMatch(p, "^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$")) return null;
        var ctx = new TraceContext(p[3..35], p[36..52], byte.Parse(p[53..], NumberStyles.HexNumber), h.GetValueOrDefault("tracestate", ""));
        return ctx.IsValid ? ctx : null;
    }
}

/// <summary>Explicit flush lifecycle; recording only updates bounded memory.</summary>
public sealed class Client
{
    internal static Dictionary<string, object> Obj(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
        return result;
    }
    internal static byte[] Encode(object value) => JsonSerializer.SerializeToUtf8Bytes(value);
    internal static string Nano() => ((DateTimeOffset.UtcNow.Ticks - DateTimeOffset.UnixEpoch.Ticks) * 100L).ToString(CultureInfo.InvariantCulture);
    internal static List<object> Attrs(IDictionary<string, object>? values)
    {
        var result = new List<object>();
        if (values?.Count > 32) throw new ArgumentException("attribute count exceeded");
        foreach (var pair in (values ?? new Dictionary<string, object>()).OrderBy(p => p.Key, StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(pair.Key) || Encoding.UTF8.GetByteCount(pair.Key) > 128) throw new ArgumentException("invalid attribute key");
            object value = pair.Value switch
            {
                string v => Obj("stringValue", v),
                bool v => Obj("boolValue", v),
                sbyte or byte or short or ushort or int or uint or long => Obj("intValue", Convert.ToInt64(pair.Value).ToString(CultureInfo.InvariantCulture)),
                float v when float.IsFinite(v) => Obj("doubleValue", (double)v),
                double v when double.IsFinite(v) => Obj("doubleValue", v),
                _ => throw new ArgumentException("attributes require string/bool/Int64/finite double")
            };
            result.Add(Obj("key", pair.Key, "value", value));
        }
        if (Encode(result).Length > 4096) throw new ArgumentException("attribute bytes exceeded");
        return result;
    }
    internal sealed record Batch(long Sequence, string Id, string Created, string Table, string Signal, byte[] Payload, int Count);
    internal sealed class State
    {
        internal readonly object Gate = new();
        internal readonly SemaphoreSlim Delivery = new(1, 1);
        internal readonly Limits Limits;
        internal readonly string Endpoint;
        internal readonly object Resource;
        internal readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = Timeout.InfiniteTimeSpan };
        internal readonly Dictionary<string, Metric> Metrics = new();
        internal readonly Dictionary<(string Table, string Signal), List<object>> Records = new();
        internal readonly Queue<Batch> Queue = new();
        internal readonly Dictionary<string, long> Stats = new();
        internal string Key, LastError = "";
        internal string? Failure;
        internal bool Closed;
        internal long Sequence;
        internal State(string service, string endpoint, string key, Limits limits)
        {
            var uri = new Uri(endpoint);
            if (string.IsNullOrEmpty(service) || Encoding.UTF8.GetByteCount(service) > 128 ||
                (uri.Scheme != "http" && uri.Scheme != "https") || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
                throw new ArgumentException("valid service and HTTP(S) endpoint required");
            if (limits.QueueBytes <= 0 || limits.BufferBytes <= 0 || limits.QueueBatches <= 0 || limits.MaxBatchBytes <= 0 ||
                limits.MaxBatchBytes > limits.QueueBytes || limits.CardinalityLimit <= 0 || limits.MaxInstruments <= 0) throw new ArgumentException("invalid SDK limits");
            Endpoint = endpoint.TrimEnd('/'); Key = key; Limits = limits;
            Resource = Obj("attributes", Attrs(new Dictionary<string, object> { ["service.name"] = service, ["service.instance.id"] = Guid.NewGuid().ToString() }));
            foreach (string name in new[] { "pending_batches", "pending_bytes", "buffer_bytes", "delivered_batches", "retried_batches", "invalid_records", "overflow_records", "dropped_records", "rejected_records" }) Stats[name] = 0;
        }
        internal void Invalid(string message) { Stats["invalid_records"]++; LastError = message; }
        internal void Lost(int count, string message) { Stats["dropped_records"] += count; Failure = LastError = message; }
        internal bool Reserve(long n)
        {
            if (Stats["buffer_bytes"] + n > Limits.BufferBytes) { Lost(1, "SDK active buffer exceeded"); return false; }
            Stats["buffer_bytes"] += n; return true;
        }
        internal void Store(string table, string signal, object record)
        {
            lock (Gate)
            {
                if (Closed) { Invalid("record after shutdown"); return; }
                if (!Reserve(Encode(record).Length + 64)) return;
                Rows(table, signal).Add(record);
            }
        }
        internal List<object> Rows(string table, string signal)
        {
            if (!Records.TryGetValue((table, signal), out var rows)) Records[(table, signal)] = rows = new();
            return rows;
        }
        internal byte[] Payload(string signal, List<object> rows)
        {
            if (signal == "metrics")
            {
                var merged = new Dictionary<string, Dictionary<string, object>>();
                foreach (Dictionary<string, object> record in rows)
                {
                    string name = (string)record["name"], kind = new[] { "sum", "gauge", "histogram" }.First(record.ContainsKey);
                    var part = (Dictionary<string, object>)record[kind];
                    var points = ((Dictionary<string, object>[])part["dataPoints"]).Cast<object>().ToList();
                    if (!merged.TryGetValue(name, out var previous))
                    {
                        var copy = new Dictionary<string, object>(record);
                        copy[kind] = new Dictionary<string, object>(part) { ["dataPoints"] = points };
                        merged[name] = copy;
                    }
                    else ((List<object>)((Dictionary<string, object>)previous[kind])["dataPoints"]).AddRange(points);
                }
                rows = merged.Values.Cast<object>().ToList();
            }
            var (resource, scope, field) = signal switch
            {
                "metrics" => ("resourceMetrics", "scopeMetrics", "metrics"),
                "logs" => ("resourceLogs", "scopeLogs", "logRecords"),
                _ => ("resourceSpans", "scopeSpans", "spans")
            };
            return Encode(Obj(resource, new[] { Obj("resource", Resource, scope, new[] { Obj("scope", Obj("name", "lightmoni/sdk/dotnet", "version", "0.1.0"), field, rows) }) }));
        }
        internal void Collect()
        {
            long now = long.Parse(Nano());
            foreach (var m in Metrics.Values)
            {
                long end = Math.Max(now, m.Start);
                foreach (var p in m.Series.Values)
                {
                    var row = Obj("attributes", p.Attrs, "timeUnixNano", m.Kind == "gauge" ? p.At.ToString() : end.ToString());
                    var record = Obj("name", m.Name, "unit", m.Unit);
                    if (m.Kind == "counter") { row["startTimeUnixNano"] = m.Start.ToString(); row["asInt"] = p.Integer.ToString(); record["sum"] = Obj("dataPoints", new[] { row }, "aggregationTemporality", 1, "isMonotonic", true); }
                    else if (m.Kind == "gauge") { row["asDouble"] = p.Value; record["gauge"] = Obj("dataPoints", new[] { row }); }
                    else
                    {
                        row["startTimeUnixNano"] = m.Start.ToString(); row["count"] = p.Count.ToString(); row["sum"] = p.Value;
                        row["min"] = p.Min; row["max"] = p.Max; row["explicitBounds"] = m.Bounds; row["bucketCounts"] = p.Buckets.Select(n => n.ToString()).ToArray();
                        record["histogram"] = Obj("dataPoints", new[] { row }, "aggregationTemporality", 1);
                    }
                    Rows(m.Table, "metrics").Add(record);
                }
                m.Series.Clear(); m.Start = end;
            }
            string created = DateTimeOffset.UtcNow.ToString("O");
            foreach (var (pair, rows) in Records.OrderBy(p => p.Key.Table).ThenBy(p => p.Key.Signal))
            {
                var group = new List<object>(); int size = Payload(pair.Signal, new()).Length;
                foreach (var record in rows)
                {
                    int cost = Encode(record).Length + 1;
                    if (group.Count > 0 && size + cost > Limits.MaxBatchBytes) { Enqueue(pair.Table, pair.Signal, group, created); group = new(); size = Payload(pair.Signal, new()).Length; }
                    group.Add(record); size += cost;
                }
                if (group.Count > 0) Enqueue(pair.Table, pair.Signal, group, created);
            }
            Records.Clear(); Stats["buffer_bytes"] = 0;
        }
        void Enqueue(string table, string signal, List<object> rows, string created)
        {
            byte[] raw = Payload(signal, rows); Sequence++;
            if (raw.Length > Limits.MaxBatchBytes || Queue.Count >= Limits.QueueBatches || Stats["pending_bytes"] + raw.Length > Limits.QueueBytes) { Lost(rows.Count, "SDK queue or batch capacity exceeded"); return; }
            Queue.Enqueue(new(Sequence, Guid.NewGuid().ToString(), created, table, signal, raw, rows.Count));
            Stats["pending_bytes"] += raw.Length; Stats["pending_batches"]++;
        }
    }
    readonly State state;
    readonly string table;
    static string ValidTable(string value) => Regex.IsMatch(value, "^[a-z][a-z0-9_]{0,47}$") && !Regex.IsMatch(value, "^(log|metric|trace)_") ? value : throw new ArgumentException("invalid logical table");
    public Client(string service, string table, string endpoint = "http://127.0.0.1:4318", string key = "", Limits? limits = null) { this.table = ValidTable(table); state = new(service, endpoint, key, limits ?? new()); }
    Client(State state, string table) { this.state = state; this.table = ValidTable(table); }
    public Client WithTable(string table) => new(state, table);
    public Metric Counter(string name, string unit = "") => Instrument(name, "counter", unit, Array.Empty<double>());
    public Metric Gauge(string name, string unit = "") => Instrument(name, "gauge", unit, Array.Empty<double>());
    public Metric Histogram(string name, double[]? boundaries = null, string unit = "") => Instrument(name, "histogram", unit, boundaries ?? new double[] { 5, 10, 25, 50, 100, 250, 500, 1000 });
    Metric Instrument(string name, string kind, string unit, double[] boundaries)
    {
        var bounds = boundaries.ToArray();
        if (string.IsNullOrEmpty(name) || Encoding.UTF8.GetByteCount(name) > 255 || Encoding.UTF8.GetByteCount(unit) > 64 || bounds.Length > 128 ||
            bounds.Where((n, i) => !double.IsFinite(n) || i > 0 && bounds[i - 1] >= n).Any()) throw new ArgumentException("invalid metric identity/boundaries");
        lock (state.Gate)
        {
            if (state.Closed) throw new InvalidOperationException("SDK is closed");
            string id = table + "\0" + name;
            if (state.Metrics.TryGetValue(id, out var metric)) { if (metric.Kind != kind || metric.Unit != unit || !metric.Bounds.SequenceEqual(bounds)) throw new ArgumentException("conflicting metric registration"); return metric; }
            if (state.Metrics.Count >= state.Limits.MaxInstruments) throw new ArgumentException("instrument limit exceeded");
            return state.Metrics[id] = new(state, table, name, kind, unit, bounds);
        }
    }
    public void Log(string severity, string body, IDictionary<string, object>? attributes = null, TraceContext? context = null)
    {
        lock (state.Gate)
        {
            try
            {
                string level = severity.ToLowerInvariant(); int i = Array.IndexOf(new[] { "trace", "debug", "info", "warn", "error", "fatal" }, level);
                if (i < 0 || Encoding.UTF8.GetByteCount(body) > 65536 || context is { IsValid: false }) throw new ArgumentException("invalid log severity/body/context");
                string now = Nano(); var row = Obj("timeUnixNano", now, "observedTimeUnixNano", now, "severityText", level, "severityNumber", 1 + 4 * i, "body", Obj("stringValue", body), "attributes", Attrs(attributes));
                if (context != null) { row["traceId"] = context.TraceId; row["spanId"] = context.SpanId; row["flags"] = context.Flags; }
                state.Store(table, "logs", row);
            }
            catch (ArgumentException e) { state.Invalid(e.Message); }
        }
    }
    public Span StartSpan(string name, IDictionary<string, object>? attributes = null, TraceContext? parent = null)
    {
        lock (state.Gate) { if (state.Closed) throw new InvalidOperationException("SDK is closed"); return new(state, table, name, attributes, parent); }
    }
    public Dictionary<string, object> Stats() { lock (state.Gate) { var result = state.Stats.ToDictionary(p => p.Key, p => (object)p.Value); result["last_error"] = state.LastError; return result; } }
    public void UpdateKey(string key) { lock (state.Gate) state.Key = key; }
    public async Task FlushAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        var duration = timeout ?? TimeSpan.FromSeconds(10);
        if (duration <= TimeSpan.Zero) throw new ArgumentException("timeout must be positive");
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); deadline.CancelAfter(duration); var token = deadline.Token;
        await state.Delivery.WaitAsync(token);
        try
        {
            long target; lock (state.Gate) { if (state.Closed) throw new InvalidOperationException("SDK is closed"); state.Collect(); target = state.Sequence; }
            double backoff = 200;
            while (true)
            {
                Batch batch; string key;
                lock (state.Gate) { if (state.Queue.Count == 0 || state.Queue.Peek().Sequence > target) { if (state.Failure != null) throw new IOException(state.Failure); return; } batch = state.Queue.Peek(); key = state.Key; }
                token.ThrowIfCancellationRequested();
                int status = 0; double delay = 0; long rejected = 0; bool ack = false;
                using var requestDeadline = CancellationTokenSource.CreateLinkedTokenSource(token); requestDeadline.CancelAfter(TimeSpan.FromSeconds(10));
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, state.Endpoint + "/v1/" + batch.Signal);
                    request.Content = new ByteArrayContent(batch.Payload); request.Content.Headers.ContentType = new("application/json");
                    request.Headers.Add("X-Lightmoni-Table", batch.Table); request.Headers.Add("X-Lightmoni-Batch-ID", batch.Id); request.Headers.Add("X-Lightmoni-Batch-Created-At", batch.Created);
                    if (!string.IsNullOrEmpty(key)) request.Headers.Authorization = new("Bearer", key);
                    using var response = await state.Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestDeadline.Token);
                    status = (int)response.StatusCode;
                    var retry = response.Headers.RetryAfter;
                    delay = retry?.Delta?.TotalMilliseconds ?? (retry?.Date is { } date ? Math.Max(0, (date - DateTimeOffset.UtcNow).TotalMilliseconds) : 0);
                    if (status == 200)
                    {
                        using var stream = await response.Content.ReadAsStreamAsync(requestDeadline.Token); using var data = new MemoryStream();
                        byte[] buffer = new byte[4096]; int size;
                        while ((size = await stream.ReadAsync(buffer, requestDeadline.Token)) != 0) { if (data.Length + size > 65536) throw new IOException("ACK too large"); data.Write(buffer, 0, size); }
                        using var result = JsonDocument.Parse(data.Length == 0 ? "{}"u8.ToArray() : data.ToArray());
                        if (result.RootElement.ValueKind != JsonValueKind.Object) throw new JsonException("invalid acknowledgment");
                        if (result.RootElement.TryGetProperty("partialSuccess", out var partial) && partial.ValueKind != JsonValueKind.Null)
                        {
                            if (partial.ValueKind != JsonValueKind.Object) throw new JsonException("invalid partial success");
                            string field = batch.Signal == "logs" ? "rejectedLogRecords" : batch.Signal == "metrics" ? "rejectedDataPoints" : "rejectedSpans";
                            if (partial.TryGetProperty(field, out var value)) rejected = value.ValueKind == JsonValueKind.String ? long.Parse(value.GetString()!, CultureInfo.InvariantCulture) : value.GetInt64();
                            if (rejected < 0) throw new JsonException("invalid partial success");
                        }
                        ack = true;
                    }
                }
                catch (Exception e) when (e is HttpRequestException or IOException or JsonException or FormatException or OperationCanceledException) { token.ThrowIfCancellationRequested(); status = 0; }
                lock (state.Gate)
                {
                    if (ack || !new[] { 0, 401, 403, 429, 502, 503, 504 }.Contains(status))
                    {
                        state.Queue.Dequeue(); state.Stats["pending_batches"]--; state.Stats["pending_bytes"] -= batch.Payload.Length;
                        if (ack && rejected == 0) state.Stats["delivered_batches"]++;
                        else { state.Stats["rejected_records"] += rejected > 0 ? rejected : batch.Count; state.Failure = state.LastError = ack ? "OTLP partial success; not retried" : $"telemetry rejected with HTTP {status}"; }
                        backoff = 200; continue;
                    }
                    state.Stats["retried_batches"]++; state.LastError = $"telemetry delivery failed (HTTP {status})";
                }
                delay = Math.Max(delay, status is 401 or 403 ? 30000 : backoff * (.8 + Random.Shared.NextDouble() * .4));
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(delay, int.MaxValue)), token); backoff = Math.Min(30000, backoff * 2);
            }
        }
        finally { state.Delivery.Release(); }
    }
    public async Task ShutdownAsync(TimeSpan? timeout = null, CancellationToken cancellationToken = default)
    {
        try { await FlushAsync(timeout, cancellationToken); } finally { lock (state.Gate) state.Closed = true; }
    }
}

public sealed class Metric
{
    internal sealed class Point
    {
        internal object Attrs = new object(); internal long Integer, Count, At; internal double Value, Min, Max; internal long[] Buckets = Array.Empty<long>();
    }
    readonly Client.State state;
    internal readonly string Table, Name, Kind, Unit;
    internal readonly double[] Bounds;
    internal long Start = long.Parse(Client.Nano());
    internal readonly Dictionary<string, Point> Series = new();
    internal Metric(Client.State state, string table, string name, string kind, string unit, double[] bounds) { this.state = state; Table = table; Name = name; Kind = kind; Unit = unit; Bounds = bounds; }
    public void Add(long value = 1, IDictionary<string, object>? attributes = null) { if (Kind != "counter") throw new InvalidOperationException("add requires counter"); RecordNumber(value, value, attributes); }
    public void Record(double value, IDictionary<string, object>? attributes = null) { if (Kind == "counter") throw new InvalidOperationException("use Add(long)"); RecordNumber(0, value, attributes); }
    void RecordNumber(long integer, double value, IDictionary<string, object>? attributes)
    {
        lock (state.Gate)
        {
            try
            {
                if (state.Closed || !double.IsFinite(value) || Kind == "counter" && integer < 0) throw new ArgumentException("invalid metric value or closed SDK");
                object attrs = Client.Attrs(attributes); string key = Encoding.UTF8.GetString(Client.Encode(attrs));
                if (!Series.ContainsKey(key) && Series.Count >= state.Limits.CardinalityLimit) { key = "overflow"; attrs = Client.Attrs(new Dictionary<string, object> { ["otel.metric.overflow"] = true }); state.Stats["overflow_records"]++; }
                if (!Series.TryGetValue(key, out var p)) { if (!state.Reserve(Encoding.UTF8.GetByteCount(key) + 160 + 8 * (Bounds.Length + 1))) return; Series[key] = p = new() { Attrs = attrs, Min = value, Max = value, Buckets = new long[Bounds.Length + 1] }; }
                if (Kind == "counter") p.Integer = checked(p.Integer + integer);
                else if (Kind == "gauge") p.Value = value;
                else
                {
                    if (!double.IsFinite(p.Value + value) || p.Count == long.MaxValue) throw new ArgumentException("histogram overflow");
                    p.Value += value; p.Count++; int i = 0; while (i < Bounds.Length && value > Bounds[i]) i++; p.Buckets[i]++; p.Min = Math.Min(p.Min, value); p.Max = Math.Max(p.Max, value);
                }
                p.At = long.Parse(Client.Nano());
            }
            catch (Exception e) when (e is ArgumentException or OverflowException) { state.Invalid(e.Message); }
        }
    }
}

public sealed class Span : IDisposable
{
    readonly Client.State state; readonly string table; readonly Dictionary<string, object> data; bool ended;
    public TraceContext Context { get; }
    internal Span(Client.State state, string table, string name, IDictionary<string, object>? attrs, TraceContext? parent)
    {
        if (string.IsNullOrEmpty(name) || Encoding.UTF8.GetByteCount(name) > 255 || parent is { IsValid: false }) throw new ArgumentException("invalid span name/context");
        this.state = state; this.table = table;
        Context = new(parent?.TraceId ?? Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N")[..16], parent?.Flags ?? 1, parent?.TraceState ?? "");
        data = Client.Obj("name", name, "kind", 1, "traceId", Context.TraceId, "spanId", Context.SpanId, "flags", Context.Flags, "startTimeUnixNano", Client.Nano(), "attributes", Client.Attrs(attrs));
        if (parent != null) { data["parentSpanId"] = parent.SpanId; if (parent.TraceState.Length > 0) data["traceState"] = parent.TraceState; }
    }
    public void SetError(string message) { lock (state.Gate) if (!ended) data["status"] = Client.Obj("code", 2, "message", message[..Math.Min(message.Length, 4096)]); }
    public void End() { lock (state.Gate) { if (ended) return; ended = true; data["endTimeUnixNano"] = Math.Max(long.Parse(Client.Nano()), long.Parse((string)data["startTimeUnixNano"])).ToString(); state.Store(table, "traces", data); } }
    public void Dispose() => End();
}
