package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Uses the existing, unmodified Agent binary protocol, real control/file/probe/
// queue loops and local HTTP fixtures. No supplier, real machine registration or
// ClickHouse write occurs outside the test instance.
func TestAgentTaskMultiLabelAppliedByExistingRuntimeAndForwardingSurvivesWithdrawal(t *testing.T) {
	s := testGroupServer(t)
	logsLabel := createTaskLabel(t, s, "logs")
	probeLabel := createTaskLabel(t, s, "checks")
	dir := t.TempDir()
	file := filepath.Join(dir, "orders.log")
	if err := os.WriteFile(file, []byte("before-label-change\n"), 0600); err != nil {
		t.Fatal(err)
	}
	createIndependentTask(t, s, "orders files", "log", []string{logsLabel.ID}, agent.RemoteConfig{LogTable: "files", LogSources: []agent.LogSource{{Directory: dir, Pattern: "*.log", FromBeginning: true}}})
	var probeCalls atomic.Int64
	probeTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { probeCalls.Add(1); w.WriteHeader(204) }))
	defer probeTarget.Close()
	createIndependentTask(t, s, "service check", "probe", []string{probeLabel.ID}, agent.RemoteConfig{Probes: []agent.Probe{{ID: "service", Kind: "http", Target: probeTarget.URL, IntervalSeconds: 1, TimeoutMS: 1000, ExpectedStatus: []int{204}}}})
	seenLogs := make(chan string, 32)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && (r.URL.Path == "/v1/logs" || r.URL.Path == "/v1/metrics" || r.URL.Path == "/v1/traces") {
			if r.URL.Path == "/v1/logs" {
				raw, _ := io.ReadAll(r.Body)
				var logs logcollector.ExportLogsServiceRequest
				var err error
				if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
					err = protojson.Unmarshal(raw, &logs)
				} else {
					err = proto.Unmarshal(raw, &logs)
				}
				if err != nil {
					t.Error(err)
				}
				for _, resource := range logs.ResourceLogs {
					for _, scope := range resource.ScopeLogs {
						for _, record := range scope.LogRecords {
							select {
							case seenLogs <- record.GetBody().GetStringValue():
							default:
							}
						}
					}
				}
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, "{}")
			return
		}
		s.Public.ServeHTTP(w, r)
	}))
	defer upstream.Close()
	cfg := agent.DefaultConfig()
	cfg.Endpoint = upstream.URL
	cfg.Key = "agent-test-key"
	cfg.GroupID = logsLabel.ID
	cfg.DataDir = t.TempDir()
	cfg.Listen = "127.0.0.1:0"
	cfg.ControlIntervalSeconds = 1
	node, err := agent.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- node.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
		if err := node.Close(); err != nil {
			t.Error(err)
		}
	}()
	waitLog := func(expected string) {
		t.Helper()
		timer := time.NewTimer(8 * time.Second)
		defer timer.Stop()
		for {
			select {
			case value := <-seenLogs:
				if value == expected {
					return
				}
			case <-timer.C:
				t.Fatalf("did not forward %q", expected)
			}
		}
	}
	waitRevision := func(revision string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			status, e := node.Status(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			if status["config_revision"] == revision {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("node did not apply label configuration")
	}
	waitLog("before-label-change")
	if probeCalls.Load() != 0 {
		t.Fatal("unmatched probe executed")
	}
	setTaskLabels(t, s, node.ID(), logsLabel.ID, probeLabel.ID)
	both := remoteTasks(t, s, node.ID())
	waitRevision(both.Revision)
	deadline := time.Now().Add(3 * time.Second)
	for probeCalls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if probeCalls.Load() == 0 {
		t.Fatal("second label task never executed")
	}
	setTaskLabels(t, s, node.ID())
	none := remoteTasks(t, s, node.ID())
	waitRevision(none.Revision)
	time.Sleep(300 * time.Millisecond)
	callsAfterWithdrawal := probeCalls.Load()
	out, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = out.WriteString("internal-after-withdraw\n")
	out.Close()
	if err != nil {
		t.Fatal(err)
	}
	// The local OTLP data path continues accepting business SDK data with no tasks.
	req := httptest.NewRequest("POST", "/v1/logs", strings.NewReader(`{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"business-fixture"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"business-after-withdraw"}}]}]}]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lightmoni-Table", "business")
	response := httptest.NewRecorder()
	node.Handler().ServeHTTP(response, req)
	if response.Code != 200 {
		t.Fatal("withdrawal disabled business OTLP forwarding", response.Code, response.Body)
	}
	waitLog("business-after-withdraw")
	time.Sleep(2200 * time.Millisecond)
	if probeCalls.Load() != callsAfterWithdrawal {
		t.Fatal("withdrawn probe continued to execute")
	}
	for {
		select {
		case value := <-seenLogs:
			if value == "internal-after-withdraw" {
				t.Fatal("withdrawn directory continued collecting")
			}
		default:
			return
		}
	}
}
