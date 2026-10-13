package moni

import (
	"context"
	"encoding/hex"
	"testing"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	"google.golang.org/protobuf/proto"
)

func TestLogTraceMetadataIsOptionalAndSeparateFromAttributes(t *testing.T) {
	sink := &recorder{}
	client := testClient(t, Config{Exporter: sink})
	app := client.WithTable("app")
	ctx := context.Background()
	trace := TraceContext{TraceID: "0123456789abcdef0123456789abcdef", SpanID: "0123456789abcdef", Flags: 0}
	app.Log(ctx, "info", "without trace", Attributes{"trace_id": "attribute-only"})
	// Incoming context can correlate a log without creating a local span, even
	// when the trace's sampled flag is unset.
	app.Log(ContextWithTrace(ctx, trace), "info", "with trace", nil)
	app.Log(ctx, "info", "after trace", nil)
	flush(t, client)

	logs := 0
	for _, batch := range sink.snapshot() {
		if batch.Signal != "logs" || batch.Table != "app" {
			t.Fatalf("logging created an unexpected batch: %s/%s", batch.Signal, batch.Table)
		}
		var request logcollector.ExportLogsServiceRequest
		if err := proto.Unmarshal(batch.Payload, &request); err != nil {
			t.Fatal(err)
		}
		for _, resource := range request.ResourceLogs {
			for _, scope := range resource.ScopeLogs {
				for _, log := range scope.LogRecords {
					logs++
					body := log.GetBody().GetStringValue()
					if body == "with trace" {
						if hex.EncodeToString(log.TraceId) != trace.TraceID || hex.EncodeToString(log.SpanId) != trace.SpanID || log.Flags != uint32(trace.Flags) {
							t.Fatalf("trace metadata was not preserved: %v", log)
						}
					} else if len(log.TraceId) != 0 || len(log.SpanId) != 0 || log.Flags != 0 {
						t.Fatalf("log without context acquired a trace: %v", log)
					}
					if body == "without trace" {
						found := false
						for _, attr := range log.Attributes {
							if attr.Key == "trace_id" && attr.Value.GetStringValue() == "attribute-only" {
								found = true
							}
						}
						if !found {
							t.Fatal("ordinary trace_id attribute was lost")
						}
					}
				}
			}
		}
	}
	if logs != 3 || client.Stats().InvalidRecords != 0 {
		t.Fatalf("optional trace metadata prevented logging: logs=%d stats=%+v", logs, client.Stats())
	}
}
