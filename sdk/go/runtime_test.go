package moni

import (
	"context"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	"google.golang.org/protobuf/proto"
	"strings"
	"testing"
	"time"
)

func TestRuntimeHeartbeatDiagnosticsAndSharedLifecycle(t *testing.T) {
	sink := &recorder{}
	client, err := New(Config{Service: "idle", Key: "test-key", Exporter: sink, Interval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Shutdown(context.Background())
	flush(t, client.WithTable("other"))
	metrics := decodedMetrics(t, sink.snapshot())
	if len(metrics["lightmoni.sdk.heartbeat"]) != 1 || metrics["lightmoni.sdk.heartbeat"][0].GetGauge().DataPoints[0].GetAsDouble() != 1 {
		t.Fatal("idle root heartbeat missing")
	}
	flush(t, client)
	if len(sink.snapshot()) != 2 {
		t.Fatal("WithTable duplicated runtime lifecycle or heartbeat was not throttled")
	}
	counter, _ := client.WithTable("business").Counter("requests", MetricOptions{})
	counter.Add(context.Background(), -1, nil)
	client.s.mu.Lock()
	client.s.selfLast = time.Now().Add(-31 * time.Second)
	client.s.mu.Unlock()
	flush(t, client)
	metrics = decodedMetrics(t, sink.snapshot())
	points := metrics["lightmoni.sdk.invalid_records"]
	if len(points) != 2 || points[1].GetGauge().DataPoints[0].GetAsDouble() != 1 {
		t.Fatal("diagnostic snapshot did not report invalid input")
	}
	logs := 0
	for _, batch := range sink.snapshot() {
		if batch.Table != "lightmoni_sdk" {
			t.Fatal("runtime did not use the shared SDK stream")
		}
		if batch.Signal == "logs" {
			var request logcollector.ExportLogsServiceRequest
			if err = proto.Unmarshal(batch.Payload, &request); err != nil {
				t.Fatal(err)
			}
			for _, rs := range request.ResourceLogs {
				for _, scope := range rs.ScopeLogs {
					for _, row := range scope.LogRecords {
						logs++
						if !strings.Contains(row.GetBody().GetStringValue(), "LightMoni SDK") {
							t.Fatal("unexpected runtime log")
						}
					}
				}
			}
		}
	}
	if logs != 2 {
		t.Fatal("expected startup and diagnostic change logs", logs)
	}
}

func TestRuntimeAtCapacityDoesNotRecursivelyRecordLoss(t *testing.T) {
	client, err := New(Config{Service: "bounded", Key: "test-key", Exporter: &recorder{}, MaxBatchBytes: 64, QueueBytes: 64})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Shutdown(context.Background())
	flush(t, client)
	if stats := client.Stats(); stats.DroppedRecords != 0 || stats.InvalidRecords != 0 || stats.PendingBatches != 0 {
		t.Fatalf("self telemetry overflow affected business diagnostics: %+v", stats)
	}
}

func TestRuntimeIdleTimerProducesHeartbeat(t *testing.T) {
	sink := &recorder{}
	client, err := New(Config{Service: "idle-timer", Key: "test-key", Exporter: sink, Interval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Shutdown(context.Background())
	deadline := time.Now().Add(33 * time.Second)
	for time.Now().Before(deadline) {
		if len(sink.snapshot()) >= 2 {
			if len(decodedMetrics(t, sink.snapshot())["lightmoni.sdk.heartbeat"]) != 1 {
				t.Fatal("idle timer did not produce heartbeat")
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("idle heartbeat requires no business record or explicit flush")
}

func TestUnboundAnonymousClientOnlySendsExplicitBusinessTables(t *testing.T) {
	sink := &recorder{}
	client, err := New(Config{Service: "unbound", Exporter: sink, Interval: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Shutdown(context.Background())
	if _, err = client.Counter("missing", MetricOptions{}); err == nil {
		t.Fatal("unbound metric accepted")
	}
	client.WithTable("first").Logger(context.Background()).Log("info", "first", nil)
	client.WithTable("second").Logger(context.Background()).Log("info", "second", nil)
	flush(t, client)
	batches := sink.snapshot()
	if len(batches) != 2 {
		t.Fatalf("anonymous client emitted unexpected batches: %d", len(batches))
	}
	for _, b := range batches {
		if b.Table != "first" && b.Table != "second" {
			t.Fatal("implicit table", b.Table)
		}
	}
}
