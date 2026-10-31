package moni_test

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	moni "github.com/workhold/lightmoni/sdk/go"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// This exercises the center-compatible OTLP protocol sink, including Node's
// OTLP JSON special hex mapping. The core service/ClickHouse hop has its own
// system integration checks; this test does not replace them.
func TestSDKsDurablyAcceptedByCenterSink(t *testing.T) {
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
	center := newNodeCenter(t, root, "127.0.0.1:0")
	client, err := moni.New(moni.Config{DisableSelfTelemetry: true, Service: "example-go-api", Table: "http", Endpoint: center.url})
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
	cmd.Env = append(cmd.Env, "LIGHTMONI_ENDPOINT="+center.url, "LIGHTMONI_SERVICE=example-node-api", "LIGHTMONI_COUNT=3", "LIGHTMONI_SELF_TELEMETRY=false")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("Node demo: %v\n%s", err, output)
	}
	queued := center.stop(t)
	logs := map[string]map[string]bool{}
	spans := map[string]map[string]bool{}
	totals := map[string]int64{}
	batches := 0
	for _, b := range queued {
		batches++
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
	}
	if batches != 6 || totals["example-go-api"] != 2 || totals["example-node-api"] != 3 {
		t.Fatalf("unexpected received batches/totals: %d %+v", batches, totals)
	}
	for service, ids := range logs {
		for id := range ids {
			if !spans[service][id] {
				t.Fatalf("log trace does not match span for %s", service)
			}
		}
	}
}

// nodeTestCenter runs the isolated center OTLP sink.
// It never starts collectors or forwards to the real center. On stop it returns
// the captured original frozen protobuf payloads.
type nodeTestBatch struct {
	ID      string `json:"id"`
	Signal  string `json:"signal"`
	Service string `json:"service"`
	Payload []byte `json:"payload"`
}
type nodeTestCenter struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	output  *json.Decoder
	stderr  bytes.Buffer
	cancel  context.CancelFunc
	url     string
	stopped bool
}

func newNodeCenter(t *testing.T, root, listen string) *nodeTestCenter {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for center integration")
	}
	loader := filepath.Join(root, "runtime/node_modules/tsx/dist/loader.mjs")
	if _, err = os.Stat(loader); err != nil {
		t.Fatal("install runtime dependencies with npm ci --prefix runtime before SDK integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	a := &nodeTestCenter{cancel: cancel}
	a.cmd = exec.CommandContext(ctx, node, "--import", loader, filepath.Join(root, "runtime/test/helpers/sdk-center.ts"), t.TempDir(), listen)
	a.cmd.Dir = root
	a.cmd.Stderr = &a.stderr
	stdout, err := a.cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	a.input, err = a.cmd.StdinPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	a.output = json.NewDecoder(io.LimitReader(stdout, 32<<20))
	if err = a.cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !a.stopped {
			a.cancel()
			_ = a.cmd.Wait()
		}
	})
	var ready struct {
		URL string `json:"url"`
	}
	if err = a.output.Decode(&ready); err != nil {
		a.cancel()
		_ = a.cmd.Wait()
		a.stopped = true
		t.Fatalf("Node center sink startup: %v\n%s", err, a.stderr.String())
	}
	a.url = ready.URL
	return a
}
func (a *nodeTestCenter) stop(t *testing.T) []nodeTestBatch {
	t.Helper()
	if a.stopped {
		t.Fatal("Node center sink already stopped")
	}
	if _, err := fmt.Fprintln(a.input, "stop"); err != nil {
		t.Fatal(err)
	}
	_ = a.input.Close()
	var result struct {
		Batches []nodeTestBatch `json:"batches"`
	}
	decodeErr := a.output.Decode(&result)
	waitErr := a.cmd.Wait()
	a.stopped = true
	a.cancel()
	if decodeErr != nil || waitErr != nil {
		t.Fatalf("Node center sink snapshot: %v / %v\n%s", decodeErr, waitErr, a.stderr.String())
	}
	return result.Batches
}
