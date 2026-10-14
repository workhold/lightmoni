package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// The center's SQLite, authenticated configuration APIs, Python process, and
// Agent config relay/durable receiver are real. The direct telemetry endpoint is
// a controlled OTLP receiver; no ClickHouse installation or forwarding is claimed.
func TestPythonReportingCenterAndAgent(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3.9+ is required for the SDK integration test")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, throughAgent := range []bool{false, true} {
		name := "direct-center"
		if throughAgent {
			name = "authenticated-agent"
		}
		t.Run(name, func(t *testing.T) {
			s := testGroupServer(t)
			for _, logical := range []string{"app", "secret"} {
				if _, err := s.DB.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json) VALUES(?,?,?,'log','','[]')", "log_"+logical, logical, logical); err != nil {
					t.Fatal(err)
				}
			}
			var policy moni.LogSamplingPolicy
			if err := json.Unmarshal([]byte(`{"key":"attr:user_id","rules":[{"name":"ordinary","rate":0.25,"conditions":[{"field":"attr:event","operator":"in","values":["click"]}]},{"name":"QA","rate":1,"conditions":[{"field":"attr:user_id","operator":"in","values":["qa"]}]},{"name":"VIP","rate":1,"conditions":[{"field":"attr:is_vip","operator":"in","values":[true]}]}],"exclude":[{"name":"blocked","conditions":[{"field":"attr:user_id","operator":"in","values":["blocked"]}]}]}`), &policy); err != nil {
				t.Fatal(err)
			}
			for _, logical := range []string{"app", "secret"} {
				response := groupRequest(t, s, false, "admin", http.MethodPut, "/api/v1/catalog/tables/log_"+logical+"/log-sampling", policy)
				if response.Code != http.StatusOK {
					t.Fatalf("save reporting policy: HTTP %d", response.Code)
				}
			}
			if _, err := s.DB.Exec(`UPDATE ingest_keys SET allow_all_tables=0,allowed_tables_json='["app"]' WHERE id='agent-key'`); err != nil {
				t.Fatal(err)
			}

			var mu sync.Mutex
			var received []agent.Batch
			for _, signal := range []string{"logs", "metrics", "traces"} {
				signal := signal
				s.Public.HandleFunc("POST /v1/"+signal, func(w http.ResponseWriter, r *http.Request) {
					key, err := s.Auth.ValidateKey(r)
					if err != nil || s.Auth.AuthorizeTable(key, r.Header.Get("X-Lightmoni-Table")) != nil {
						w.WriteHeader(http.StatusUnauthorized)
						return
					}
					body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
					if err != nil {
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					mu.Lock()
					received = append(received, agent.Batch{Signal: signal, Table: r.Header.Get("X-Lightmoni-Table"), ID: r.Header.Get("X-Lightmoni-Batch-ID"), ContentType: "application/json", Payload: body})
					mu.Unlock()
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{}`))
				})
			}
			center := httptest.NewServer(s.Public)
			defer center.Close()
			endpoint, token := center.URL, "agent-test-key"
			drain := func() []agent.Batch {
				mu.Lock()
				defer mu.Unlock()
				batches := received
				received = nil
				return batches
			}
			if throughAgent {
				cfg := agent.DefaultConfig()
				cfg.Endpoint, cfg.Key, cfg.LocalToken = center.URL, token, "python-local-fixture-token"
				cfg.DataDir, cfg.MinFreeBytes = t.TempDir(), 0
				runtime, err := agent.New(cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer runtime.Close()
				relay := httptest.NewServer(runtime.Handler())
				defer relay.Close()
				endpoint, token = relay.URL, cfg.LocalToken
				queue, err := agent.OpenQueue(cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer queue.Close()
				drain = func() []agent.Batch {
					var batches []agent.Batch
					for {
						item, exists, err := queue.Next(context.Background())
						if err != nil {
							t.Fatal(err)
						}
						if !exists {
							return batches
						}
						batches = append(batches, item.Batch)
						if err := queue.Complete(context.Background(), item.ID); err != nil {
							t.Fatal(err)
						}
					}
				}
				// A center Key is not a valid local token, including after cache fill.
				pythonReportingConfig(t, endpoint, "", http.StatusUnauthorized)
				pythonReportingConfig(t, endpoint, "agent-test-key", http.StatusUnauthorized)
			}
			config := pythonReportingConfig(t, endpoint, token, http.StatusOK)
			if len(config.LogSampling) != 1 || config.LogSampling["app"].Rules == nil || config.Revision == "" {
				t.Fatal("real configuration leaked the forbidden table or lost the allowed policy")
			}
			pythonReportingConfig(t, endpoint, "wrong-fixture-token", http.StatusUnauthorized)
			process := newPythonReportingProcess(t, python, root, endpoint, token)
			stats := process.step(t, "sample")
			if stats["config_revision"] != config.Revision || stats["excluded_logs"] != float64(1) || stats["unmatched_logs"] != float64(2) || stats["dropped_records"] != float64(0) {
				t.Fatalf("sampling diagnostics disagree with platform configuration: %v", stats)
			}
			initial := pythonReportingDecode(t, drain())
			if initial.metricTotal != 20 || strings.Join(initial.spans, ",") != "sample" {
				t.Fatalf("log policy changed metrics or spans: metrics=%d spans=%v", initial.metricTotal, initial.spans)
			}
			cohorts := map[string]int{}
			for body, log := range initial.logs {
				if strings.HasPrefix(body, "ordinary-") {
					parts := strings.Split(body, "-")
					cohorts[parts[1]]++
					pythonReportingMetadata(t, log, .25, "ordinary")
				} else if body == "qa" || body == "qa-child" || body == "vip" {
					rule := "QA"
					if body == "vip" {
						rule = "VIP"
					}
					pythonReportingMetadata(t, log, 1, rule)
				} else {
					t.Fatalf("excluded or unmatched log reached telemetry: %s", body)
				}
			}
			for _, body := range []string{"qa", "qa-child", "vip"} {
				if initial.logs[body] == nil {
					t.Fatalf("full-coverage log missing: %s", body)
				}
			}
			if len(cohorts) < 25 || len(cohorts) > 85 {
				t.Fatalf("unexpected 25%% UID cohort size: %d/200", len(cohorts))
			}
			for uid, count := range cohorts {
				if count != 2 {
					t.Fatalf("UID %s changed cohort between events: %d retained", uid, count)
				}
			}
			stats = process.step(t, "prepare-stop")
			if stats["buffer_bytes"].(float64) <= 0 {
				t.Fatal("stop fixture did not buffer data")
			}
			stop := []moni.LogExcludeRule{{Name: "Python fixture", Conditions: []moni.LogCondition{
				{Field: "service", Operator: "in", Values: []any{"python-reporting-fixture"}},
				{Field: "instance_id", Operator: "in", Values: []any{"python-reporting-one"}},
				{Field: "sdk.language", Operator: "in", Values: []any{"python"}},
				{Field: "resource:deployment.environment", Operator: "in", Values: []any{"isolated-test"}},
			}}}
			setStop := func(rules []moni.LogExcludeRule) {
				response := groupRequest(t, s, false, "admin", http.MethodPut, "/api/v1/settings/sdk-reporting", map[string]any{"disable_rules": rules})
				if response.Code != http.StatusOK {
					t.Fatalf("save platform stop selectors: HTTP %d", response.Code)
				}
			}
			setStop(stop)
			stats = process.step(t, "wait-stopped")
			if stats["reporting_disabled"] != true || stats["pending_batches"] != float64(0) || stats["buffer_bytes"] != float64(0) || len(drain()) != 0 {
				t.Fatalf("remote stop retained or sent buffered data: %v", stats)
			}
			setStop([]moni.LogExcludeRule{})
			stats = process.step(t, "wait-resumed")
			if stats["reporting_disabled"] != false || stats["disabled_records"].(float64) < 5 {
				t.Fatalf("remote polling did not resume shared SDK state: %v", stats)
			}
			resumed := pythonReportingDecode(t, drain())
			if resumed.metricTotal != 3 || strings.Join(resumed.spans, ",") != "fresh" || len(resumed.logs) != 2 || resumed.logs["fresh-after-resume"] == nil || resumed.logs["fresh-child"] == nil {
				t.Fatalf("stopped records or old spans were backfilled: metrics=%d spans=%v logs=%v", resumed.metricTotal, resumed.spans, resumed.logs)
			}
			process.step(t, "shutdown")
			if err := process.command.Wait(); err != nil {
				t.Fatalf("Python process shutdown: %v", err)
			}
		})
	}
}

func pythonReportingConfig(t *testing.T, endpoint, token string, status int) moni.SDKConfig {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, endpoint+"/v1/sdk-config", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
	if err != nil {
		t.Fatal("configuration request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != status {
		t.Fatalf("configuration authorization: got HTTP %d, want %d", response.StatusCode, status)
	}
	var config moni.SDKConfig
	if status == http.StatusOK {
		if err := json.NewDecoder(response.Body).Decode(&config); err != nil {
			t.Fatal(err)
		}
	}
	return config
}

type pythonReportingProcess struct {
	command *exec.Cmd
	input   io.WriteCloser
	output  *bufio.Scanner
	stderr  bytes.Buffer
}

func newPythonReportingProcess(t *testing.T, python, root, endpoint, token string) *pythonReportingProcess {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	p := &pythonReportingProcess{command: exec.CommandContext(ctx, python, "-u", "-c", pythonReportingProgram)}
	p.command.Dir = root
	// Test credentials exist only in this isolated process; no inherited project
	// credentials or active user endpoints are used by the fixture program.
	p.command.Env = append(os.Environ(), "PYTHONPATH="+filepath.Join(root, "sdk/python"), "PYTHON_REPORTING_ENDPOINT="+endpoint, "PYTHON_REPORTING_TOKEN="+token)
	p.command.Stderr = &p.stderr
	var err error
	p.input, err = p.command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := p.command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	p.output = bufio.NewScanner(output)
	if err := p.command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.input.Close()
		if p.command.ProcessState == nil {
			cancel()
			_ = p.command.Wait()
		}
	})
	return p
}

func (p *pythonReportingProcess) step(t *testing.T, phase string) map[string]any {
	t.Helper()
	if _, err := fmt.Fprintln(p.input, phase); err != nil {
		t.Fatalf("send Python fixture phase: %v", err)
	}
	if !p.output.Scan() {
		// Wait before reading stderr: exec's copy goroutine owns the buffer until
		// the process exits, and the integration test itself is run under -race.
		_ = p.command.Wait()
		t.Fatalf("Python fixture stopped during %s: %s", phase, p.stderr.String())
	}
	var stats map[string]any
	if err := json.Unmarshal(p.output.Bytes(), &stats); err != nil {
		t.Fatalf("invalid Python fixture output during %s: %v", phase, err)
	}
	return stats
}

type pythonReportingRecords struct {
	logs        map[string]*logpb.LogRecord
	metricTotal int64
	spans       []string
}

func pythonReportingDecode(t *testing.T, batches []agent.Batch) pythonReportingRecords {
	t.Helper()
	result := pythonReportingRecords{logs: map[string]*logpb.LogRecord{}}
	for _, batch := range batches {
		if batch.Table != "app" || batch.ID == "" {
			t.Fatal("telemetry batch changed table or lost its identity")
		}
		decode := func(message proto.Message) {
			var err error
			if strings.Contains(batch.ContentType, "json") {
				err = protojson.Unmarshal(batch.Payload, message)
			} else {
				err = proto.Unmarshal(batch.Payload, message)
			}
			if err != nil {
				t.Fatal(err)
			}
		}
		switch batch.Signal {
		case "logs":
			var request logcollector.ExportLogsServiceRequest
			decode(&request)
			for _, resource := range request.ResourceLogs {
				for _, scope := range resource.ScopeLogs {
					for _, log := range scope.LogRecords {
						body := log.Body.GetStringValue()
						if result.logs[body] != nil {
							t.Fatalf("duplicate log payload: %s", body)
						}
						result.logs[body] = log
					}
				}
			}
		case "metrics":
			var request metriccollector.ExportMetricsServiceRequest
			decode(&request)
			for _, resource := range request.ResourceMetrics {
				for _, scope := range resource.ScopeMetrics {
					for _, metric := range scope.Metrics {
						if metric.Name == "requests" {
							for _, point := range metric.GetSum().GetDataPoints() {
								result.metricTotal += point.GetAsInt()
							}
						}
					}
				}
			}
		case "traces":
			var request tracecollector.ExportTraceServiceRequest
			decode(&request)
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, span := range scope.Spans {
						result.spans = append(result.spans, span.Name)
					}
				}
			}
		default:
			t.Fatalf("unexpected signal: %s", batch.Signal)
		}
	}
	return result
}

func pythonReportingMetadata(t *testing.T, log *logpb.LogRecord, rate float64, rule string) {
	t.Helper()
	metadata := map[string]any{}
	for _, attribute := range log.Attributes {
		switch attribute.Key {
		case "lightmoni.sampling.rate", "lightmoni.sampling.weight":
			metadata[attribute.Key] = attribute.Value.GetDoubleValue()
		case "lightmoni.sampling.rule":
			metadata[attribute.Key] = attribute.Value.GetStringValue()
		}
	}
	if metadata["lightmoni.sampling.rate"] != rate || metadata["lightmoni.sampling.weight"] != 1/rate || metadata["lightmoni.sampling.rule"] != rule {
		t.Fatalf("non-authoritative sampling metadata for %s: %v", log.Body.GetStringValue(), metadata)
	}
}

const pythonReportingProgram = `
import json, os, sys, time
from lightmoni import Client
mon = Client("python-reporting-fixture", "app", endpoint=os.environ["PYTHON_REPORTING_ENDPOINT"], key=os.environ["PYTHON_REPORTING_TOKEN"], self_telemetry=False, config_interval=1, instance_id="python-reporting-one", resource={"deployment.environment": "isolated-test"})
child = mon.with_table("app")
counter = mon.counter("requests")
def wait_disabled(expected):
    deadline = time.monotonic() + 6
    while mon.stats()["reporting_disabled"] is not expected:
        if time.monotonic() >= deadline:
            raise AssertionError("independent platform polling did not change reporting state")
        time.sleep(.02)
for command in sys.stdin:
    phase = command.strip()
    if phase == "sample":
        mon.refresh_config()
        counter.add(20, {"user_id": "blocked"})
        with mon.start_span("sample", {"user_id": "blocked"}):
            mon.log("info", "qa", {"user_id": "qa", "event": "click", "lightmoni.sampling.rate": 0.01, "lightmoni.sampling.weight": 100.0, "lightmoni.sampling.rule": "spoof"})
            child.log("info", "qa-child", {"user_id": "qa"})
            mon.log("info", "vip", {"is_vip": True})
            mon.log("error", "blocked-vip", {"user_id": "blocked", "is_vip": True})
            mon.log("info", "string-vip", {"is_vip": "true"})
            mon.log("error", "unmatched")
        for uid in range(200):
            for event in range(2):
                mon.log("info", "ordinary-%03d-%d" % (uid, event), {"user_id": str(uid), "event": "click"})
        mon.flush(timeout=5)
    elif phase == "prepare-stop":
        old = mon.start_span("before-stop")
        mon.log("info", "buffered-before-stop", {"user_id": "qa"})
        child.log("info", "buffered-child", {"user_id": "qa"})
        counter.add(100)
    elif phase == "wait-stopped":
        wait_disabled(True)
        stopped = mon.start_span("during-stop")
        mon.log("info", "ignored-during-stop", {"user_id": "qa"})
        child.log("info", "ignored-child", {"user_id": "qa"})
        counter.add(1000)
        mon.flush(timeout=2)
    elif phase == "wait-resumed":
        wait_disabled(False)
        old.end()
        stopped.end()
        counter.add(3)
        with mon.start_span("fresh"):
            mon.log("info", "fresh-after-resume", {"user_id": "qa"})
            child.log("info", "fresh-child", {"user_id": "qa"})
        mon.flush(timeout=5)
    elif phase == "shutdown":
        mon.shutdown(timeout=5)
        print(json.dumps(mon.stats()), flush=True)
        break
    else:
        raise AssertionError("unknown fixture phase")
    print(json.dumps(mon.stats()), flush=True)
`
