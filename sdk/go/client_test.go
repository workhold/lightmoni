package moni

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
)

type recorder struct {
	mu      sync.Mutex
	batches []FrozenBatch
}

func (r *recorder) Deliver(_ context.Context, b FrozenBatch) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.batches = append(r.batches, b.Clone())
	return nil
}
func (r *recorder) snapshot() []FrozenBatch {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]FrozenBatch(nil), r.batches...)
}
func testClient(t *testing.T, cfg Config) *Client {
	t.Helper()
	cfg.Service = "test-service"
	cfg.Table = "http"
	if cfg.Interval == 0 {
		cfg.Interval = time.Hour
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = c.Shutdown(ctx)
	})
	return c
}
func flush(t *testing.T, c *Client) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
}
func decodedMetrics(t *testing.T, batches []FrozenBatch) map[string][]*metricpb.Metric {
	t.Helper()
	result := map[string][]*metricpb.Metric{}
	for _, b := range batches {
		if b.Signal != "metrics" {
			continue
		}
		var req metriccollector.ExportMetricsServiceRequest
		if err := proto.Unmarshal(b.Payload, &req); err != nil {
			t.Fatal(err)
		}
		for _, r := range req.ResourceMetrics {
			for _, s := range r.ScopeMetrics {
				for _, m := range s.Metrics {
					result[m.Name] = append(result[m.Name], m)
				}
			}
		}
	}
	return result
}

func TestConcurrentCompleteDimensionsGaugeHistogramAndContext(t *testing.T) {
	r := &recorder{}
	c := testClient(t, Config{Exporter: r})
	count, err := c.Counter("requests", MetricOptions{Unit: "{request}"})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for worker := 0; worker < 10; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				status := int64(200)
				if i%2 == 1 {
					status = 500
				}
				count.Add(context.Background(), 1, Attributes{"route": "/pay", "method": "POST", "status": status})
			}
		}()
	}
	wg.Wait()
	attrs := Attributes{"route": "/pay", "method": "POST", "status": "200"}
	count.Add(context.Background(), 2, attrs)
	attrs["route"] = "/mutated"
	gauge, _ := c.Gauge("active", MetricOptions{})
	gauge.Record(context.Background(), 1, Attributes{"pool": "main"})
	gauge.Record(context.Background(), 3, Attributes{"pool": "main"})
	hist, _ := c.Histogram("duration", MetricOptions{Unit: "ms", Boundaries: []float64{1, 2}})
	for _, v := range []float64{-1, 1, 1.5, 3} {
		hist.Record(context.Background(), v, nil)
	}
	ctx, span := c.WithTable("app").StartSpan(context.Background(), "pay", Attributes{"route": "/pay"})
	c.WithTable("app").Log(ctx, "info", "complete", Attributes{"id": "p_1"})
	h := http.Header{}
	InjectHTTP(ctx, h)
	extracted := ExtractHTTP(context.Background(), h)
	trace, ok := TraceContextFromContext(extracted)
	if !ok || trace.TraceID != span.Context().TraceID {
		t.Fatal("W3C trace context roundtrip failed")
	}
	span.End()
	span.End()
	flush(t, c)
	metrics := decodedMetrics(t, r.snapshot())
	var total int64
	points := 0
	for _, m := range metrics["requests"] {
		if m.GetSum().AggregationTemporality != metricpb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA {
			t.Fatal("not Delta")
		}
		for _, p := range m.GetSum().DataPoints {
			points++
			total += p.GetAsInt()
			for _, a := range p.Attributes {
				if a.Key == "route" && a.Value.GetStringValue() != "/pay" {
					t.Fatal("caller attribute mutation changed frozen dimensions")
				}
			}
		}
	}
	if total != 1002 || points != 3 {
		t.Fatalf("total=%d dimensions=%d", total, points)
	}
	if got := metrics["active"][0].GetGauge().DataPoints[0].GetAsDouble(); got != 3 {
		t.Fatalf("gauge=%v", got)
	}
	p := metrics["duration"][0].GetHistogram().DataPoints[0]
	if p.Count != 4 || p.GetSum() != 4.5 || !equalBuckets(p.BucketCounts, []uint64{2, 1, 1}) {
		t.Fatalf("bad histogram: %v", p)
	}
	signals := map[string]int{}
	for _, b := range r.snapshot() {
		signals[b.Signal]++
		if b.CreatedAt == "" || b.Service != "test-service" {
			t.Fatal("missing frozen envelope")
		}
	}
	if signals["logs"] != 1 || signals["traces"] != 1 {
		t.Fatalf("missing log/span: %v", signals)
	}
}
func equalBuckets(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRetryKeepsFrozenBatchAndNextWindowIndependent(t *testing.T) {
	first := make(chan struct{})
	release := make(chan struct{})
	var mu sync.Mutex
	calls := []FrozenBatch{}
	unique := map[string]FrozenBatch{}
	exporter := ExporterFunc(func(ctx context.Context, b FrozenBatch) error {
		mu.Lock()
		calls = append(calls, b.Clone())
		unique[b.ID] = b.Clone()
		n := len(calls)
		mu.Unlock()
		if n == 1 {
			close(first)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return errors.New("accepted but ACK lost")
		}
		return nil
	})
	c := testClient(t, Config{Exporter: exporter, RetryMin: time.Millisecond, RetryMax: 2 * time.Millisecond})
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 7, nil)
	done := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		done <- c.Flush(ctx)
	}()
	<-first
	counter.Add(context.Background(), 3, nil)
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	flush(t, c)
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 || calls[0].ID != calls[1].ID || calls[0].CreatedAt != calls[1].CreatedAt || !bytes.Equal(calls[0].Payload, calls[1].Payload) || calls[2].ID == calls[0].ID {
		t.Fatalf("unstable retry batches: %v", len(calls))
	}
	var sum int64
	for _, b := range unique {
		for _, m := range decodedMetrics(t, []FrozenBatch{b})["requests"] {
			for _, p := range m.GetSum().DataPoints {
				sum += p.GetAsInt()
			}
		}
	}
	if sum != 10 {
		t.Fatalf("unique total=%d", sum)
	}
}

func TestFlushWaitsForDurableAckAndBoundedQueueReportsLoss(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	exporter := ExporterFunc(func(ctx context.Context, b FrozenBatch) error {
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	c := testClient(t, Config{Exporter: exporter, QueueBatches: 1})
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 1, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	err := c.Flush(ctx)
	cancel()
	if err == nil {
		t.Fatal("flush succeeded before durable ACK")
	}
	<-started
	if c.Stats().PendingBatches != 1 {
		t.Fatal("unacknowledged batch discarded")
	}
	c.WithTable("app").Log(context.Background(), "info", "queue full", nil)
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Millisecond)
	_ = c.Flush(ctx)
	cancel()
	if c.Stats().DroppedRecords != 1 || c.Stats().PendingBatches != 1 {
		t.Fatalf("not bounded: %+v", c.Stats())
	}
	close(release)
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	err = c.Flush(ctx)
	cancel()
	if err == nil {
		t.Fatal("queue loss falsely reported as successful flush")
	}
}

func TestCardinalityOverflowPreservesTotalsAndAttributeTypes(t *testing.T) {
	r := &recorder{}
	c := testClient(t, Config{Exporter: r, CardinalityLimit: 2})
	counter, _ := c.Counter("requests", MetricOptions{})
	for i := 0; i < 5; i++ {
		counter.Add(context.Background(), 2, Attributes{"route": i})
	}
	flush(t, c)
	var total int64
	var overflow int64
	for _, m := range decodedMetrics(t, r.snapshot())["requests"] {
		for _, p := range m.GetSum().DataPoints {
			total += p.GetAsInt()
			for _, a := range p.Attributes {
				if a.Key == "otel.metric.overflow" && a.Value.GetBoolValue() {
					overflow = p.GetAsInt()
				}
			}
		}
	}
	if total != 10 || overflow != 6 || c.Stats().OverflowRecords != 3 {
		t.Fatalf("lost overflow: total=%d overflow=%d stats=%+v", total, overflow, c.Stats())
	}
}

func TestHTTPAuthenticationRotationPreservesBatch(t *testing.T) {
	var calls atomic.Int32
	var mu sync.Mutex
	ids := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		mu.Lock()
		ids = append(ids, r.Header.Get("X-Lightmoni-Batch-ID"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer new-global-key" {
			w.WriteHeader(401)
			return
		}
		if r.Header.Get("X-Lightmoni-Table") != "http" || r.Header.Get("X-Lightmoni-Batch-Created-At") == "" {
			t.Error("missing envelope headers")
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}))
	defer server.Close()
	c := testClient(t, Config{Endpoint: server.URL, Key: "old-global-key"})
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 1, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := c.Flush(ctx)
	cancel()
	if err == nil {
		t.Fatal("unauthorized delivery succeeded")
	}
	if err := c.UpdateKey("new-global-key"); err != nil {
		t.Fatal(err)
	}
	flush(t, c)
	mu.Lock()
	defer mu.Unlock()
	if calls.Load() < 2 || ids[0] != ids[len(ids)-1] {
		t.Fatal("key rotation changed batch or discarded queued data")
	}
}

func TestPartialSuccessIsNotRetried(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		payload, _ := proto.Marshal(&metriccollector.ExportMetricsServiceResponse{PartialSuccess: &metriccollector.ExportMetricsPartialSuccess{RejectedDataPoints: 1}})
		w.Header().Set("Content-Type", "application/x-protobuf")
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	c := testClient(t, Config{Endpoint: server.URL})
	counter, _ := c.Counter("requests", MetricOptions{})
	counter.Add(context.Background(), 1, nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := c.Flush(ctx); err == nil {
		t.Fatal("partial rejection silently succeeded")
	}
	if calls.Load() != 1 || c.Stats().RejectedRecords != 1 || c.Stats().RetriedBatches != 0 {
		t.Fatal("partial success retried")
	}
}
