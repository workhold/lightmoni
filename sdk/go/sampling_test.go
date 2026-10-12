package moni

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
)

func reportingPolicy(t *testing.T, raw string) LogSamplingPolicy {
	t.Helper()
	p, e := DecodeLogSampling(strings.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	return p
}

const reportingRules = `{"key":"attr:user_id","rules":[{"name":"QA","rate":1,"conditions":[{"field":"attr:user_id","operator":"in","values":["qa"]}]},{"name":"VIP","rate":1,"conditions":[{"field":"attr:is_vip","operator":"in","values":[true]}]},{"name":"click","rate":0.1,"conditions":[{"field":"attr:event","operator":"in","values":["click"]}]}],"exclude":[{"name":"blocked UID","conditions":[{"field":"attr:user_id","operator":"in","values":["blocked"]}]}]}`

func TestLogRulesWhitelistPriorityTypesAndStableCohorts(t *testing.T) {
	p := reportingPolicy(t, reportingRules)
	record := Attributes{"event_id": "event", "service": "app", "severity": "ERROR"}
	cases := []struct {
		attrs  Attributes
		keep   bool
		reason string
	}{{Attributes{"user_id": "qa", "event": "click"}, true, "QA"}, {Attributes{"is_vip": true}, true, "VIP"}, {Attributes{"is_vip": "true"}, false, "unmatched"}, {Attributes{"user_id": "blocked", "is_vip": true}, false, "excluded"}, {Attributes{}, false, "unmatched"}}
	for _, c := range cases {
		k, _, reason := p.decide("web", record, c.attrs, nil)
		if k != c.keep || reason != c.reason {
			t.Fatalf("%v: %v %s", c.attrs, k, reason)
		}
	}
	kept := 0
	for i := 0; i < 10000; i++ {
		attrs := Attributes{"user_id": strconv.Itoa(i), "event": "click"}
		a, _, _ := p.decide("web", record, attrs, nil)
		record["event_id"] = strconv.Itoa(i + 1)
		b, _, _ := p.decide("web", record, attrs, nil)
		if a != b {
			t.Fatal("split user cohort")
		}
		if a {
			kept++
		}
	}
	if kept < 700 || kept > 1300 {
		t.Fatalf("unexpected sample distribution: %d", kept)
	}
	for _, raw := range []string{`{}`, `{"rules":null}`, `{"rules":[{"conditions":[]}]}`, `{"rules":[{"rate":1,"conditions":[{"field":"attr:vip","operator":"in","values":[]}]}]}`, `{"rules":[],"unknown":true}`, `{"rules":[],"exclude":[{"name":"all","conditions":[]}]}`} {
		if _, err := DecodeLogSampling(strings.NewReader(raw)); err == nil {
			t.Fatal("accepted unsafe policy", raw)
		}
	}
	empty := reportingPolicy(t, `{"rules":[]}`)
	if keep, _, _ := empty.decide("web", record, Attributes{"is_vip": true}, nil); keep {
		t.Fatal("empty whitelist reported log")
	}
}
func TestLogRulesNeverSampleMetricsOrSpans(t *testing.T) {
	var mu sync.Mutex
	var batches []FrozenBatch
	c, err := New(Config{Service: "rules", Table: "web", DisableSelfTelemetry: true, Interval: time.Hour, LogSampling: map[string]LogSamplingPolicy{"web": reportingPolicy(t, reportingRules)}, Exporter: ExporterFunc(func(_ context.Context, b FrozenBatch) error {
		mu.Lock()
		defer mu.Unlock()
		batches = append(batches, b)
		return nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Shutdown(context.Background())
	attrs := Attributes{"user_id": "blocked", "is_vip": true}
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 20, attrs)
	c.Log(context.Background(), "info", "blocked", attrs)
	c.Log(context.Background(), "info", "qa", Attributes{"user_id": "qa"})
	_, span := c.StartSpan(context.Background(), "blocked-user", attrs)
	span.End()
	if err = c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	counts := map[string]int{}
	for _, b := range batches {
		counts[b.Signal]++
		if b.Signal == "logs" {
			var req logcollector.ExportLogsServiceRequest
			_ = proto.Unmarshal(b.Payload, &req)
			if len(req.ResourceLogs[0].ScopeLogs[0].LogRecords) != 1 || req.ResourceLogs[0].ScopeLogs[0].LogRecords[0].Body.GetStringValue() != "qa" {
				t.Fatal("wrong whitelist")
			}
		}
		if b.Signal == "metrics" {
			var req metriccollector.ExportMetricsServiceRequest
			_ = proto.Unmarshal(b.Payload, &req)
			if req.ResourceMetrics[0].ScopeMetrics[0].Metrics[0].GetSum().DataPoints[0].GetAsInt() != 20 {
				t.Fatal("sampled metric total")
			}
		}
	}
	if counts["logs"] != 1 || counts["metrics"] != 1 || counts["traces"] != 1 || c.Stats().ExcludedLogs != 1 {
		t.Fatal(counts, c.Stats())
	}
}
func TestDynamicSDKStopResumeAndInvalidConfigKeepsLastPolicy(t *testing.T) {
	var mu sync.Mutex
	config := SDKConfig{Revision: "v1", LogSampling: map[string]LogSamplingPolicy{}, DisableRules: []LogExcludeRule{}}
	invalid := false
	var batches []FrozenBatch
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer rotated" {
			w.WriteHeader(401)
			return
		}
		if invalid {
			_, _ = w.Write([]byte(`{"log_sampling":{}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(config)
	}))
	defer endpoint.Close()
	c, err := New(Config{Service: "stop-me", Table: "web", InstanceID: "one", Key: "rotated", ConfigEndpoint: endpoint.URL, DisableSelfTelemetry: true, Interval: time.Hour, Exporter: ExporterFunc(func(_ context.Context, b FrozenBatch) error {
		mu.Lock()
		defer mu.Unlock()
		batches = append(batches, b)
		return nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Shutdown(context.Background())
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 10, nil)
	c.Log(context.Background(), "info", "buffered", nil)
	mu.Lock()
	config.DisableRules = []LogExcludeRule{{Name: "one instance", Conditions: []LogCondition{{Field: "instance_id", Operator: "in", Values: []any{"one"}}}}}
	config.Revision = "v2"
	mu.Unlock()
	if err = c.RefreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 100, nil)
	c.Log(context.Background(), "info", "disabled", nil)
	_, span := c.StartSpan(context.Background(), "disabled")
	span.End()
	if err = c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !c.Stats().ReportingDisabled || c.Stats().PendingBatches != 0 || c.Stats().BufferBytes != 0 {
		t.Fatal(c.Stats())
	}
	mu.Lock()
	if len(batches) != 0 {
		t.Fatal("stopped SDK sent data")
	}
	invalid = true
	mu.Unlock()
	if err = c.RefreshConfig(context.Background()); err == nil || !c.Stats().ReportingDisabled {
		t.Fatal("invalid response changed configuration")
	}
	mu.Lock()
	invalid = false
	config.DisableRules = []LogExcludeRule{}
	config.Revision = "v3"
	mu.Unlock()
	if err = c.RefreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	counter.Add(context.Background(), 3, nil)
	c.Log(context.Background(), "info", "resumed", nil)
	if err = c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(batches) != 2 || c.Stats().ReportingDisabled {
		t.Fatal("resume failed", len(batches))
	}
	for _, b := range batches {
		if b.Signal == "metrics" {
			var req metriccollector.ExportMetricsServiceRequest
			_ = proto.Unmarshal(b.Payload, &req)
			if req.ResourceMetrics[0].ScopeMetrics[0].Metrics[0].GetSum().DataPoints[0].GetAsInt() != 3 {
				t.Fatal("disabled window was backfilled")
			}
		}
	}
}

func TestSDKDisableCancelsFrozenBatchAndSuppressesSpansAcrossResume(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var mu sync.Mutex
	var delivered []FrozenBatch
	calls := 0
	c, err := New(Config{Service: "cancel", Table: "web", DisableSelfTelemetry: true, Interval: time.Hour, Exporter: ExporterFunc(func(ctx context.Context, b FrozenBatch) error {
		mu.Lock()
		calls++
		attempt := calls
		mu.Unlock()
		if attempt == 1 {
			close(started)
			<-ctx.Done()
			close(cancelled)
			return ctx.Err()
		}
		mu.Lock()
		delivered = append(delivered, b)
		mu.Unlock()
		return nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Shutdown(context.Background())
	_, oldSpan := c.StartSpan(context.Background(), "before stop")
	c.Log(context.Background(), "info", "frozen", nil)
	flushed := make(chan error, 1)
	go func() { flushed <- c.Flush(context.Background()) }()
	<-started
	c.SetReportingEnabled(false)
	<-cancelled
	if err = <-flushed; err != nil {
		t.Fatal("intentional stop failed flush", err)
	}
	_, stoppedSpan := c.StartSpan(context.Background(), "during stop")
	c.SetReportingEnabled(true)
	oldSpan.End()
	stoppedSpan.End()
	c.Log(context.Background(), "info", "new", nil)
	if err = c.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(delivered) != 1 || delivered[0].Signal != "logs" || c.Stats().PendingBatches != 0 {
		t.Fatal("stopped data was replayed", len(delivered), c.Stats())
	}
}
