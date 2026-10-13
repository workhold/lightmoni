using LightMoni;
using System.Text.Json;
static string Env(string n, string fallback) => Environment.GetEnvironmentVariable(n) ?? fallback;
static Dictionary<string, object> A(params object[] pairs) { var a = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) a[(string)pairs[i]] = pairs[i + 1]; return a; }
static void Require(bool v) { if (!v) throw new Exception("SDK conformance assertion"); }
string mode = Env("LIGHTMONI_TEST_MODE", "demo");
var limits = mode == "overflow" ? new Limits(CardinalityLimit: 2) : mode == "capacity" ? new Limits(QueueBytes: 1024, MaxBatchBytes: 1024, BufferBytes: 64) : new Limits();
limits=limits with { SelfTelemetry=mode is "demo" or "selfmonitor" };
var mon = new Client(Env("LIGHTMONI_SERVICE", "example-dotnet-api"), "http", Env("LIGHTMONI_ENDPOINT", "http://127.0.0.1:4318"), Env("LIGHTMONI_KEY", ""), limits);
var counter = mon.Counter("http.requests");
switch (mode)
{
    case "selfmonitor":
        counter.Add(-1); await Task.Delay(35000); await mon.ShutdownAsync(TimeSpan.FromSeconds(5)); break;
    case "fixture":
        var dims = A("route", "/payments", "method", "POST", "status", 200);
        counter.Add(1, dims); dims["status"] = 999;
        counter.Add(2, A("status", 200, "method", "POST", "route", "/payments")); counter.Add(1, A("status", 500, "method", "POST", "route", "/payments"));
        counter.Add(1, A("typed", 1)); counter.Add(1, A("typed", "1")); counter.Add(-1);
        mon.Counter("exact").Add(9007199254740993L);
        var gauge = mon.Gauge("active"); gauge.Record(5); gauge.Record(7);
        var histogram = mon.Histogram("duration", new double[] { 5, 10 }); foreach (double n in new double[] { -1, 5, 6, 10, 11 }) histogram.Record(n);
        var parent = TraceContext.Extract(new Dictionary<string, string> { ["traceparent"] = "00-" + new string('a', 32) + "-" + new string('b', 16) + "-01", ["tracestate"] = "foo=bar" })!;
        Require(TraceContext.Extract(new Dictionary<string, string> { ["traceparent"] = "00-" + new string('0', 32) + "-" + new string('b', 16) + "-01" }) == null);
        Require(TraceContext.Extract(parent.Inject()) == parent);
        var app = mon.WithTable("app");
        app.Log("info", "without trace", A("trace_id", "attribute-only"));
        using (var span = app.StartSpan("fixture", parent: parent)) app.Log("info", "中文 fixture", A("exact", 9007199254740993L, "ok", true, "fraction", .125), span.Context);
        app.Log("info", "after trace");
        await mon.FlushAsync(); counter.Add(2, A("window", "next")); await mon.FlushAsync(); break;
    case "overflow":
        for (int i = 0; i < 4; i++) counter.Add(1, A("dimension", i));
        await mon.FlushAsync(); break;
    case "retry":
    case "auth":
        counter.Add(1, A("window", "first")); bool failed = false;
        try { await mon.FlushAsync(TimeSpan.FromMilliseconds(450)); } catch (OperationCanceledException) { failed = true; }
        Require(failed && (long)mon.Stats()["pending_batches"] == 1);
        counter.Add(2, A("window", "next")); mon.UpdateKey("rotated"); await mon.FlushAsync(); break;
    case "permanent":
    case "partial":
    case "capacity":
        counter.Add(1);
        for (int i = 0; i < 2; i++) { bool loss = false; try { await mon.FlushAsync(); } catch (IOException) { loss = true; } Require(loss); }
        Require((long)mon.Stats()["pending_batches"] == 0); break;
    default:
        var business = mon.WithTable("app"); var duration = mon.Histogram("http.duration", new double[] { 5, 10, 25, 50, 100, 250 }); var active = mon.Gauge("http.active");
        for (int i = 0; i < int.Parse(Env("LIGHTMONI_COUNT", "20")); i++)
        {
            int status = i % 5 == 0 ? 500 : 200;
            using var span = business.StartSpan("POST /payments");
            var a = A("route", "/payments", "method", "POST", "status", status);
            counter.Add(1, a); duration.Record(5 + i * 2, a); active.Record(i % 4);
            business.Log(status == 500 ? "error" : "info", "sample payment completed", A("sample_id", i, "status", status), span.Context);
            if (status == 500) span.SetError("sample payment failed");
        }
        await mon.ShutdownAsync(TimeSpan.FromSeconds(15)); break;
}
Console.WriteLine(JsonSerializer.Serialize(mon.Stats()));
