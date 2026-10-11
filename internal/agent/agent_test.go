package agent

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	"github.com/shirou/gopsutil/v4/process"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Endpoint = "http://127.0.0.1:1"
	cfg.Key = "shared-global-key"
	cfg.DataDir = t.TempDir()
	cfg.CollectIntervalSeconds = 3600
	return cfg
}
func newTestAgent(t *testing.T, cfg Config) *Agent {
	t.Helper()
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a
}
func logBatch(t *testing.T, service string) Batch {
	t.Helper()
	at := time.Now().UTC()
	request := &logcollector.ExportLogsServiceRequest{ResourceLogs: []*logpb.ResourceLogs{{Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{{Key: "service.name", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: service}}}, {Key: "service.instance.id", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "process-1"}}}}}, ScopeLogs: []*logpb.ScopeLogs{{LogRecords: []*logpb.LogRecord{{TimeUnixNano: uint64(at.UnixNano()), Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "hello"}}}}}}}}}
	data, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return Batch{ID: uuid.NewString(), Signal: "logs", Table: "business", Service: service, CreatedAt: at, Payload: data, ContentType: "application/x-protobuf"}
}
func exportRequest(b Batch) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/"+b.Signal, bytes.NewReader(b.Payload))
	r.Header.Set("Content-Type", b.ContentType)
	r.Header.Set("X-Lightmoni-Table", b.Table)
	r.Header.Set("X-Lightmoni-Batch-ID", b.ID)
	r.Header.Set("X-Lightmoni-Batch-Created-At", b.CreatedAt.Format(time.RFC3339Nano))
	return r
}

func TestDurableReceiptSurvivesRestartAndCompletedRetry(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	b := logBatch(t, "order-api")
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(b))
	if response.Code != 200 {
		t.Fatalf("receive=%d %s", response.Code, response.Body.String())
	}
	stored, ok, err := a.queue.Next(ctx)
	if err != nil || !ok {
		t.Fatalf("not durable: %v", err)
	}
	frozen := bytes.Clone(stored.Payload)
	originalIdentity := a.identity
	var req logcollector.ExportLogsServiceRequest
	if err = proto.Unmarshal(frozen, &req); err != nil {
		t.Fatal(err)
	}
	if resourceString(req.ResourceLogs[0].Resource, "host.id") != a.identity.HostID || resourceString(req.ResourceLogs[0].Resource, "lightmoni.agent_id") != a.ID() {
		t.Fatal("missing trusted resource identity")
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if a.identity != originalIdentity {
		t.Fatal("restart changed identity")
	}
	stored, ok, err = a.queue.Next(ctx)
	if err != nil || !ok || !bytes.Equal(stored.Payload, frozen) {
		t.Fatal("restart changed frozen data")
	}
	if err = a.queue.Complete(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	// The SDK retries an ACK it never received after the Agent already forwarded
	// and removed spool data. Receipt remains durable and no new batch is added.
	if err = a.Accept(ctx, b, true); err != nil {
		t.Fatal(err)
	}
	stats, _ := a.queue.Stats(ctx)
	if stats.Batches != 0 || stats.Receipts != 1 {
		t.Fatalf("duplicate created queue data: %+v", stats)
	}
	changed := b
	changed.Payload = append(bytes.Clone(b.Payload), 0)
	if err = a.Accept(ctx, changed, true); err == nil {
		t.Fatal("batch content conflict accepted")
	}
}

func TestQueueAndReceiptBackpressureKeepAcceptedData(t *testing.T) {
	ctx := context.Background()
	cfg := testConfig(t)
	cfg.MaxQueueBatches = 1
	cfg.MaxReceipts = 1
	a := newTestAgent(t, cfg)
	first := logBatch(t, "one")
	if err := a.Accept(ctx, first, true); err != nil {
		t.Fatal(err)
	}
	second := logBatch(t, "two")
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(second))
	if response.Code != 503 {
		t.Fatalf("expected backpressure, got %d", response.Code)
	}
	stats, _ := a.queue.Stats(ctx)
	if stats.Batches != 1 {
		t.Fatal("full queue deleted accepted data")
	}
	if err := a.queue.Complete(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(second))
	if response.Code != 503 {
		t.Fatal("receipt guarantee window evicted to fit new data")
	}
	if err := a.Accept(ctx, first, true); err != nil {
		t.Fatal("duplicate should remain accepted at capacity", err)
	}
}

func TestReceiverDoesNotACKUnavailableStorage(t *testing.T) {
	cfg := testConfig(t)
	a := newTestAgent(t, cfg)
	if err := a.queue.Close(); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(logBatch(t, "app")))
	if response.Code != 503 {
		t.Fatalf("storage failure ACKed: %d", response.Code)
	}
}

func TestTwoServicesShareGlobalKeyAndRotationKeepsPayload(t *testing.T) {
	var mu sync.Mutex
	var keys []string
	var payloads [][]byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		keys = append(keys, r.Header.Get("Authorization"))
		payloads = append(payloads, data)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer upstream.Close()
	cfg := testConfig(t)
	cfg.Endpoint = upstream.URL
	a := newTestAgent(t, cfg)
	ctx := context.Background()
	for _, service := range []string{"order-api", "worker"} {
		client, err := moni.New(moni.Config{Service: service, Table: "business", Exporter: a, Interval: time.Hour})
		if err != nil {
			t.Fatal(err)
		}
		counter, err := client.Counter("requests", moni.MetricOptions{Unit: "1"})
		if err != nil {
			t.Fatal(err)
		}
		counter.Add(ctx, 2, moni.Attributes{"region": "cn", "result": "ok"})
		counter.Add(ctx, 3, moni.Attributes{"region": "us", "result": "ok"})
		flushCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = client.Flush(flushCtx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		shutdownCtx, stop := context.WithTimeout(ctx, time.Second)
		err = client.Shutdown(shutdownCtx)
		stop()
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		b, ok, err := a.queue.Next(ctx)
		if err != nil || !ok {
			t.Fatal("SDK batch missing")
		}
		var req metriccollector.ExportMetricsServiceRequest
		if err = proto.Unmarshal(b.Payload, &req); err != nil {
			t.Fatal(err)
		}
		var total int64
		for _, rs := range req.ResourceMetrics {
			for _, scope := range rs.ScopeMetrics {
				for _, m := range scope.Metrics {
					for _, p := range m.GetSum().DataPoints {
						total += p.GetAsInt()
					}
				}
			}
		}
		if total != 5 {
			t.Fatalf("Agent altered counter aggregation: %d", total)
		}
		if result := a.send(ctx, b); result.message != "" {
			t.Fatal(result.message)
		}
		if i == 0 {
			a.cfg.Key = "rotated-global-key"
			if result := a.send(ctx, b); result.message != "" {
				t.Fatal(result.message)
			}
		}
		if err = a.queue.Complete(ctx, b.ID); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(keys) != 3 || keys[0] != "Bearer shared-global-key" || keys[1] != "Bearer rotated-global-key" || keys[2] != "Bearer rotated-global-key" {
		t.Fatalf("wrong global key behavior %v", keys)
	}
	if !bytes.Equal(payloads[0], payloads[1]) {
		t.Fatal("key rotation changed frozen telemetry")
	}
}

func TestJSONCanonicalRetryAndBoundedInput(t *testing.T) {
	a := newTestAgent(t, testConfig(t))
	b := logBatch(t, "app")
	var req logcollector.ExportLogsServiceRequest
	_ = proto.Unmarshal(b.Payload, &req)
	jsonBytes, err := protojson.Marshal(&req)
	if err != nil {
		t.Fatal(err)
	}
	b.Payload = jsonBytes
	b.ContentType = "application/json"
	response := httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(b))
	if response.Code != 200 {
		t.Fatalf("JSON export failed: %s", response.Body.String())
	}
	if !json.Valid(response.Body.Bytes()) {
		t.Fatal("JSON OTLP success response invalid")
	}
	b.Payload, _ = protojson.MarshalOptions{Indent: "  "}.Marshal(&req)
	if err = a.Accept(context.Background(), b, true); err != nil {
		t.Fatal("equivalent decoded JSON retry rejected", err)
	}
	tooLarge := b
	tooLarge.ID = uuid.NewString()
	tooLarge.Payload = make([]byte, a.cfg.MaxBatchBytes+1)
	response = httptest.NewRecorder()
	a.Handler().ServeHTTP(response, exportRequest(tooLarge))
	if response.Code != 413 {
		t.Fatalf("oversized input=%d", response.Code)
	}
}

func TestOTLPJSONHexTraceIDsArePreserved(t *testing.T) {
	a := newTestAgent(t, testConfig(t))
	b := logBatch(t, "node-api")
	var request map[string]any
	var protoRequest logcollector.ExportLogsServiceRequest
	_ = proto.Unmarshal(b.Payload, &protoRequest)
	encoded, _ := protojson.Marshal(&protoRequest)
	_ = json.Unmarshal(encoded, &request)
	log := request["resourceLogs"].([]any)[0].(map[string]any)["scopeLogs"].([]any)[0].(map[string]any)["logRecords"].([]any)[0].(map[string]any)
	log["traceId"] = "0123456789abcdef0123456789abcdef"
	log["spanId"] = "0123456789abcdef"
	b.Payload, _ = json.Marshal(request)
	b.ContentType = "application/json"
	if err := a.Accept(context.Background(), b, true); err != nil {
		t.Fatal(err)
	}
	queued, _, _ := a.queue.Next(context.Background())
	var decoded logcollector.ExportLogsServiceRequest
	_ = proto.Unmarshal(queued.Payload, &decoded)
	record := decoded.ResourceLogs[0].ScopeLogs[0].LogRecords[0]
	if hex.EncodeToString(record.TraceId) != log["traceId"] || hex.EncodeToString(record.SpanId) != log["spanId"] {
		t.Fatal("standard OTLP JSON hex identity corrupted")
	}
}

func TestRealHostCollectionUsesEmbeddedSDK(t *testing.T) {
	a := newTestAgent(t, testConfig(t))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := a.CollectOnce(ctx); err != nil {
		t.Fatal(err)
	}
	b, ok, err := a.queue.Next(ctx)
	if err != nil || !ok {
		t.Fatal("host SDK did not durably enqueue", err)
	}
	found := false
	rows, err := a.queue.db.QueryContext(ctx, `SELECT payload FROM batches WHERE signal='metrics'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var payload []byte
		_ = rows.Scan(&payload)
		var req metriccollector.ExportMetricsServiceRequest
		_ = proto.Unmarshal(payload, &req)
		for _, r := range req.ResourceMetrics {
			if resourceString(r.Resource, "service.name") != "lightmoni-agent" {
				t.Fatal("wrong host service")
			}
			for _, scope := range r.ScopeMetrics {
				for _, m := range scope.Metrics {
					if m.Name == "host.memory.total" && len(m.GetGauge().DataPoints) > 0 && m.GetGauge().DataPoints[0].GetAsDouble() > 0 {
						found = true
					}
				}
			}
		}
	}
	rows.Close()
	if !found {
		t.Fatalf("real memory metric absent in %s batch", b.Table)
	}
}

func TestProbeAndInvalidRemoteConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer server.Close()
	p := Probe{ID: "http", Kind: "http", Target: server.URL, IntervalSeconds: 1, TimeoutMS: 1000, ExpectedStatus: []int{204}}
	if result := CheckProbe(context.Background(), p); !result.Success || result.Status != 204 {
		t.Fatalf("HTTP probe failed: %+v", result)
	}
	p.ExpectedStatus = []int{200}
	if result := CheckProbe(context.Background(), p); result.Success || result.Reason != "unexpected_status" {
		t.Fatal("unexpected status ignored")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	p = Probe{ID: "tcp", Kind: "tcp", Target: listener.Addr().String(), IntervalSeconds: 1, TimeoutMS: 1000}
	if result := CheckProbe(context.Background(), p); !result.Success {
		t.Fatal(result)
	}
	a := newTestAgent(t, testConfig(t))
	valid := RemoteConfig{Revision: "1", CollectIntervalSeconds: 5, Probes: []Probe{p}}
	if err = a.applyRemote(valid, true); err != nil {
		t.Fatal(err)
	}
	invalid := valid
	invalid.Revision = "2"
	invalid.CollectIntervalSeconds = 0
	if err = a.applyRemote(invalid, true); err == nil {
		t.Fatal("invalid config accepted")
	}
	if a.revision != "1" {
		t.Fatal("invalid config replaced active configuration")
	}
	data, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "remote-config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cached RemoteConfig
	_ = json.Unmarshal(data, &cached)
	if cached.Revision != "1" {
		t.Fatal("invalid config replaced durable cache")
	}
}

func TestConfiguredProcessCollection(t *testing.T) {
	p, err := process.NewProcess(int32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	name, err := p.Name()
	if err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.ProcessNames = []string{name}
	a := newTestAgent(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err = a.CollectOnce(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := a.queue.db.QueryContext(ctx, `SELECT payload FROM batches WHERE signal='metrics'`)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for rows.Next() {
		var payload []byte
		_ = rows.Scan(&payload)
		var req metriccollector.ExportMetricsServiceRequest
		_ = proto.Unmarshal(payload, &req)
		for _, r := range req.ResourceMetrics {
			for _, scope := range r.ScopeMetrics {
				for _, metric := range scope.Metrics {
					if metric.Name == "process.memory.rss" && len(metric.GetGauge().DataPoints) > 0 && metric.GetGauge().DataPoints[0].GetAsDouble() > 0 {
						found = true
					}
				}
			}
		}
	}
	rows.Close()
	if !found {
		t.Fatal("configured current process RSS not collected")
	}
}
