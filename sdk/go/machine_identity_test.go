package moni

import (
	"context"
	"os"
	"strings"
	"testing"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	"google.golang.org/protobuf/proto"
)

func TestMachineEnvironmentDeclarations(t *testing.T) {
	for _, test := range []struct {
		name, id, hostName string
		explicit           Attributes
		wantID, wantName   string
	}{
		{"absent", "", "", nil, "", ""},
		{"declared", "machine-1", "生产 主机", Attributes{"host.id": "agent-host"}, "machine-1", "生产 主机"},
		{"explicit", "environment", "环境", Attributes{"lightmoni.machine.id": "explicit", "lightmoni.machine.name": "custom"}, "explicit", "custom"},
		{"empty", "", "   ", nil, "", ""},
		{"too-long", strings.Repeat("a", 65), strings.Repeat("界", 43), nil, "", ""},
		{"control", "bad\nvalue", "bad\u0085value", nil, "", ""},
		{"utf8-boundary", strings.Repeat("界", 21) + "a", strings.Repeat("界", 42) + "ab", nil, strings.Repeat("界", 21) + "a", strings.Repeat("界", 42) + "ab"},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("LIGHTMONI_MACHINE_ID", test.id)
			t.Setenv("LIGHTMONI_MACHINE_NAME", test.hostName)
			if test.name == "absent" {
				if err := os.Unsetenv("LIGHTMONI_MACHINE_ID"); err != nil {
					t.Fatal(err)
				}
				if err := os.Unsetenv("LIGHTMONI_MACHINE_NAME"); err != nil {
					t.Fatal(err)
				}
			}
			recorder := &recorder{}
			client := testClient(t, Config{Exporter: recorder, Resource: test.explicit, InstanceID: "instance-1"})
			counter, err := client.Counter("requests", MetricOptions{})
			if err != nil {
				t.Fatal(err)
			}
			counter.Add(context.Background(), 1, nil)
			client.Log(context.Background(), "info", "hello", nil)
			_, span := client.StartSpan(context.Background(), "work", nil)
			span.End()
			flush(t, client)
			batches := recorder.snapshot()
			if len(batches) != 3 {
				t.Fatalf("expected 3 signals, got %d", len(batches))
			}
			for _, batch := range batches {
				var attributes []*commonpb.KeyValue
				switch batch.Signal {
				case "metrics":
					var payload metriccollector.ExportMetricsServiceRequest
					if err := proto.Unmarshal(batch.Payload, &payload); err != nil {
						t.Fatal(err)
					}
					attributes = payload.ResourceMetrics[0].Resource.Attributes
				case "logs":
					var payload logcollector.ExportLogsServiceRequest
					if err := proto.Unmarshal(batch.Payload, &payload); err != nil {
						t.Fatal(err)
					}
					attributes = payload.ResourceLogs[0].Resource.Attributes
				case "traces":
					var payload tracecollector.ExportTraceServiceRequest
					if err := proto.Unmarshal(batch.Payload, &payload); err != nil {
						t.Fatal(err)
					}
					attributes = payload.ResourceSpans[0].Resource.Attributes
				}
				resource := map[string]string{}
				for _, attribute := range attributes {
					resource[attribute.Key] = attribute.Value.GetStringValue()
				}
				if resource["lightmoni.machine.id"] != test.wantID || resource["lightmoni.machine.name"] != test.wantName {
					t.Fatalf("unexpected resource: %v", resource)
				}
				if resource["service.name"] != "test-service" || resource["service.instance.id"] != "instance-1" {
					t.Fatal("service identity changed")
				}
				if test.name == "declared" && resource["host.id"] != "agent-host" {
					t.Fatal("Agent host identity changed")
				}
				if len(test.explicit) > 0 && test.name == "declared" && len(test.explicit) != 1 {
					t.Fatal("input resource mutated")
				}
			}
		})
	}
}
