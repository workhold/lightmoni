package moni

import (
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
	"time"
)

// Self telemetry uses fixed-size snapshots and fixed diagnostic text. It never
// calls the user-facing recording API from an exporter failure or queue loss.
func (s *state) collectSelfLocked(now time.Time) {
	if s.configKey == "" || s.reportingDisabled || s.cfg.DisableSelfTelemetry || (!s.selfLast.IsZero() && now.Sub(s.selfLast) < 30*time.Second) {
		return
	}
	s.selfLast = now
	values := map[string]float64{"heartbeat": 1, "pending_batches": float64(s.stats.PendingBatches), "pending_bytes": float64(s.stats.PendingBytes), "retried_batches": float64(s.stats.RetriedBatches), "dropped_records": float64(s.stats.DroppedRecords), "rejected_records": float64(s.stats.RejectedRecords), "invalid_records": float64(s.stats.InvalidRecords), "overflow_records": float64(s.stats.OverflowRecords)}
	attributes := []*commonpb.KeyValue{kv("lightmoni.component", "sdk"), kv("sdk.language", "go"), kv("sdk.version", "0.1.0")}
	var ms []*metricpb.Metric
	for name, value := range values {
		ms = append(ms, &metricpb.Metric{Name: "lightmoni.sdk." + name, Data: &metricpb.Metric_Gauge{Gauge: &metricpb.Gauge{DataPoints: []*metricpb.NumberDataPoint{{TimeUnixNano: uint64(now.UnixNano()), Attributes: attributes, Value: &metricpb.NumberDataPoint_AsDouble{AsDouble: value}}}}}})
	}
	request := &metriccollector.ExportMetricsServiceRequest{ResourceMetrics: []*metricpb.ResourceMetrics{{Resource: s.resource, ScopeMetrics: []*metricpb.ScopeMetrics{{Scope: &commonpb.InstrumentationScope{Name: "lightmoni/sdk/runtime"}, Metrics: ms}}}}}
	// Self telemetry is lower priority than business data. A full queue does not
	// create another loss/error recursively; the next snapshot shows its state.
	s.enqueueSelfLocked("metrics", request, len(ms), now)
	event, body, level := "", "", logpb.SeverityNumber_SEVERITY_NUMBER_INFO
	if !s.selfStarted {
		event = "started"
		body = "LightMoni SDK started"
	} else if s.stats.RetriedBatches > s.selfPrevious.RetriedBatches || s.stats.DroppedRecords > s.selfPrevious.DroppedRecords || s.stats.RejectedRecords > s.selfPrevious.RejectedRecords || s.stats.InvalidRecords > s.selfPrevious.InvalidRecords || s.stats.OverflowRecords > s.selfPrevious.OverflowRecords {
		event = "diagnostics_changed"
		body = "LightMoni SDK delivery, buffer or input diagnostics changed"
		level = logpb.SeverityNumber_SEVERITY_NUMBER_WARN
	}
	if event != "" {
		attrs := append(append([]*commonpb.KeyValue{}, attributes...), kv("event", event))
		req := &logcollector.ExportLogsServiceRequest{ResourceLogs: []*logpb.ResourceLogs{{Resource: s.resource, ScopeLogs: []*logpb.ScopeLogs{{LogRecords: []*logpb.LogRecord{{TimeUnixNano: uint64(now.UnixNano()), SeverityNumber: level, SeverityText: map[bool]string{true: "WARN", false: "INFO"}[level == logpb.SeverityNumber_SEVERITY_NUMBER_WARN], Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: body}}, Attributes: attrs}}}}}}}
		if s.enqueueSelfLocked("logs", req, 1, now) {
			s.selfStarted = true
			s.selfPrevious = s.stats
		}
	}
}

func (s *state) enqueueSelfLocked(signal string, message proto.Message, records int, now time.Time) bool {
	payload, err := proto.MarshalOptions{Deterministic: true}.Marshal(message)
	if err != nil || len(payload) > s.cfg.MaxBatchBytes || len(s.queue) >= s.cfg.QueueBatches || s.stats.PendingBytes+len(payload) > s.cfg.QueueBytes {
		return false
	}
	s.enqueueLocked(signal, "lightmoni", message, records, now)
	return true
}
