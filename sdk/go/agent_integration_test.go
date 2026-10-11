package moni_test

import (
	"context"
	"encoding/hex"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// This exercises the actual Agent handler and durable spool, including Node's
// OTLP JSON special hex mapping. The core service/ClickHouse hop has its own
// system integration checks; this test does not replace them.
func TestSDKsDurablyAcceptedByActualAgent(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node not installed; run npm ci && npm test in sdk/typescript for Node checks")
	}
	if _, err = os.Stat(filepath.Join(root, "sdk/typescript/dist/src/index.js")); err != nil {
		t.Skip("build TypeScript SDK with npm ci && npm run build before cross-language integration")
	}
	cfg := agent.DefaultConfig()
	cfg.DataDir = t.TempDir()
	cfg.Endpoint = "http://127.0.0.1:1"
	cfg.Key = "test-global-key"
	cfg.MinFreeBytes = 0
	a, err := agent.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(a.Handler())
	defer server.Close()
	closed := false
	t.Cleanup(func() {
		if !closed {
			_ = a.Close()
		}
	})
	client, err := moni.New(moni.Config{Service: "example-go-api", Table: "http", Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	counter, err := client.Counter("http.requests", moni.MetricOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, span := client.WithTable("app").StartSpan(context.Background(), "pay")
	counter.Add(ctx, 2, moni.Attributes{"route": "/payments", "method": "POST", "status": 200})
	client.WithTable("app").Log(ctx, "info", "sample payment completed", nil)
	span.End()
	flushCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	err = client.Shutdown(flushCtx)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, filepath.Join(root, "examples/sdk/node/index.mjs"))
	cmd.Dir = root
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "LIGHTMONI_") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "LIGHTMONI_ENDPOINT="+server.URL, "LIGHTMONI_SERVICE=example-node-api", "LIGHTMONI_COUNT=3")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Node demo: %v\n%s", err, output)
	}
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	queue, err := agent.OpenQueue(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	logs := map[string]map[string]bool{}
	spans := map[string]map[string]bool{}
	totals := map[string]int64{}
	batches := 0
	for {
		item, ok, err := queue.Next(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if !ok {
			break
		}
		batches++
		b := item.Batch
		switch b.Signal {
		case "metrics":
			var request metriccollector.ExportMetricsServiceRequest
			if err = proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					for _, metric := range scope.Metrics {
						if metric.Name == "http.requests" {
							for _, point := range metric.GetSum().DataPoints {
								totals[b.Service] += point.GetAsInt()
							}
						}
					}
				}
			}
		case "logs":
			var request logcollector.ExportLogsServiceRequest
			if err = proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			if logs[b.Service] == nil {
				logs[b.Service] = map[string]bool{}
			}
			for _, resource := range request.ResourceLogs {
				for _, scope := range resource.ScopeLogs {
					for _, record := range scope.LogRecords {
						if len(record.TraceId) != 16 || len(record.SpanId) != 8 {
							t.Fatalf("bad OTLP trace identity for %s: %d/%d bytes", b.Service, len(record.TraceId), len(record.SpanId))
						}
						logs[b.Service][hex.EncodeToString(record.TraceId)] = true
					}
				}
			}
		case "traces":
			var request tracecollector.ExportTraceServiceRequest
			if err = proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			if spans[b.Service] == nil {
				spans[b.Service] = map[string]bool{}
			}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, span := range scope.Spans {
						if len(span.TraceId) != 16 || len(span.SpanId) != 8 {
							t.Fatal("bad OTLP span identity")
						}
						spans[b.Service][hex.EncodeToString(span.TraceId)] = true
					}
				}
			}
		}
		if err = queue.Complete(context.Background(), b.ID); err != nil {
			t.Fatal(err)
		}
	}
	if batches != 6 || totals["example-go-api"] != 2 || totals["example-node-api"] != 3 {
		t.Fatalf("unexpected durable batches/totals: %d %+v", batches, totals)
	}
	for service, ids := range logs {
		for id := range ids {
			if !spans[service][id] {
				t.Fatalf("log trace does not match span for %s", service)
			}
		}
	}
}
