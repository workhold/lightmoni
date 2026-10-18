package moni

import (
	"context"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	"google.golang.org/protobuf/proto"
	"testing"
	"time"
)

func TestRecordAggregatesSamplesAndPreservesSummaryWithoutInventedDistribution(t *testing.T) {
	sink := &recorder{}
	client, err := New(Config{Service: "record", Env: "test", ServiceVersion: "v1", InstanceID: "fixed", Exporter: sink, DisableSelfTelemetry: true, Interval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 1000; i++ {
		client.Record("app", "duration", Attributes{"key1": "telecom", "key2": "zhejiang"}, float64(i), 1)
	}
	client.Record("app", "duration", Attributes{"key2": "zhejiang", "key1": "telecom"}, 100, 5)
	client.Record("app", "invalid", nil, 1, 0)
	client.Record("app", "invalid", Attributes{"isp": "bad"}, 1, 1)
	if err := client.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	count, summaryCount := uint64(0), uint64(0)
	sum, summarySum := 0., 0.
	points := 0
	for _, batch := range sink.snapshot() {
		var request metriccollector.ExportMetricsServiceRequest
		if err := proto.Unmarshal(batch.Payload, &request); err != nil {
			t.Fatal(err)
		}
		for _, resource := range request.ResourceMetrics {
			for _, scope := range resource.ScopeMetrics {
				for _, m := range scope.Metrics {
					for _, p := range m.GetExponentialHistogram().GetDataPoints() {
						points++
						count += p.Count
						sum += p.GetSum()
						total := p.ZeroCount
						for _, n := range p.GetPositive().GetBucketCounts() {
							total += n
						}
						for _, n := range p.GetNegative().GetBucketCounts() {
							total += n
						}
						if total != p.Count {
							t.Fatal("distribution lost samples")
						}
					}
					for _, p := range m.GetSummary().GetDataPoints() {
						summaryCount += p.Count
						summarySum += p.Sum
						if len(p.QuantileValues) != 0 {
							t.Fatal("summary invented percentiles")
						}
					}
				}
			}
		}
	}
	if count != 1000 || sum != 500500 || points != 1 || summaryCount != 5 || summarySum != 100 {
		t.Fatalf("bad aggregation: %d %v %d %d %v", count, sum, points, summaryCount, summarySum)
	}
	if client.Stats().InvalidRecords != 2 {
		t.Fatal("invalid inputs accepted")
	}
}
