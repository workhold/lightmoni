package moni_test

import (
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestNativeSDKsDurablyAcceptedByActualAgent(t *testing.T) {
	if os.Getenv("LIGHTMONI_NATIVE_SDK_TEST") != "1" {
		t.Skip("enable with LIGHTMONI_NATIVE_SDK_TEST=1 after scripts/test-sdks.py --docker")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	// Docker Desktop reaches this isolated receiver through its host gateway.
	agent := newNodeAgent(t, root, "0.0.0.0:0")
	command := exec.Command("python3", "scripts/test-sdks.py", "--docker", "--skip-build", "--agent-url", agent.url)
	command.Dir = root
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native SDK demos: %v\n%s", err, output)
	}
	queued := agent.stop(t)
	totals := map[string]int64{}
	logs, spans := map[string]map[string]bool{}, map[string]map[string]bool{}
	batches := 0
	for _, b := range queued {
		batches++
		switch b.Signal {
		case "metrics":
			var request metriccollector.ExportMetricsServiceRequest
			if err := proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					for _, m := range scope.Metrics {
						if m.Name == "http.requests" {
							for _, p := range m.GetSum().DataPoints {
								totals[b.Service] += p.GetAsInt()
							}
						}
					}
				}
			}
		case "logs":
			var request logcollector.ExportLogsServiceRequest
			if err := proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			logs[b.Service] = map[string]bool{}
			for _, resource := range request.ResourceLogs {
				for _, scope := range resource.ScopeLogs {
					for _, row := range scope.LogRecords {
						logs[b.Service][hex.EncodeToString(row.TraceId)+":"+hex.EncodeToString(row.SpanId)] = true
					}
				}
			}
		case "traces":
			var request tracecollector.ExportTraceServiceRequest
			if err := proto.Unmarshal(b.Payload, &request); err != nil {
				t.Fatal(err)
			}
			spans[b.Service] = map[string]bool{}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, row := range scope.Spans {
						spans[b.Service][hex.EncodeToString(row.TraceId)+":"+hex.EncodeToString(row.SpanId)] = true
					}
				}
			}
		}
	}
	if batches != 18 || len(totals) != 6 {
		t.Fatalf("expected 18 durable batches for six languages: batches=%d totals=%v", batches, totals)
	}
	for _, language := range []string{"python", "java", "dotnet", "php", "ruby", "rust"} {
		service := "conformance-" + language
		if totals[service] != 20 || len(logs[service]) != 20 || len(spans[service]) != 20 {
			t.Fatalf("%s totals=%d logs=%d spans=%d", service, totals[service], len(logs[service]), len(spans[service]))
		}
		for id := range logs[service] {
			if !spans[service][id] {
				t.Fatalf("%s unlinked log %s", service, id)
			}
		}
	}
}
