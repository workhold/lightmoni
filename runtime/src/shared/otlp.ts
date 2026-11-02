import protobuf from "protobufjs";
import { createHash } from "node:crypto";
import { parseJSON, integerString, stringifyJSON } from "./json.js";
export type Signal = "logs" | "metrics" | "traces";
interface Field {
  name: string;
  json: string;
  id: number;
  kind: string;
  message?: string;
  repeated?: boolean;
  packed?: boolean;
  presence?: boolean;
  oneof?: string;
  enum?: Record<string, number>;
}
// Generated from the pinned go.opentelemetry.io/proto/otlp v1.11.1 descriptors.
// OTLP schemas are Apache-2.0 (OpenTelemetry Authors); descriptors are embedded
// so the runtime never downloads schemas or invokes the old implementation.
const schema: Record<string, Field[]> = {
  "opentelemetry.proto.collector.logs.v1.ExportLogsPartialSuccess": [
    {
      name: "rejected_log_records",
      json: "rejectedLogRecords",
      id: 1,
      kind: "int64",
    },
    { name: "error_message", json: "errorMessage", id: 2, kind: "string" },
  ],
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest": [
    {
      name: "resource_logs",
      json: "resourceLogs",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.logs.v1.ResourceLogs",
      repeated: true,
    },
  ],
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse": [
    {
      name: "partial_success",
      json: "partialSuccess",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.collector.logs.v1.ExportLogsPartialSuccess",
      presence: true,
    },
  ],
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsPartialSuccess": [
    {
      name: "rejected_data_points",
      json: "rejectedDataPoints",
      id: 1,
      kind: "int64",
    },
    { name: "error_message", json: "errorMessage", id: 2, kind: "string" },
  ],
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest": [
    {
      name: "resource_metrics",
      json: "resourceMetrics",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.ResourceMetrics",
      repeated: true,
    },
  ],
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse": [
    {
      name: "partial_success",
      json: "partialSuccess",
      id: 1,
      kind: "message",
      message:
        "opentelemetry.proto.collector.metrics.v1.ExportMetricsPartialSuccess",
      presence: true,
    },
  ],
  "opentelemetry.proto.collector.trace.v1.ExportTracePartialSuccess": [
    { name: "rejected_spans", json: "rejectedSpans", id: 1, kind: "int64" },
    { name: "error_message", json: "errorMessage", id: 2, kind: "string" },
  ],
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest": [
    {
      name: "resource_spans",
      json: "resourceSpans",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.ResourceSpans",
      repeated: true,
    },
  ],
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse": [
    {
      name: "partial_success",
      json: "partialSuccess",
      id: 1,
      kind: "message",
      message:
        "opentelemetry.proto.collector.trace.v1.ExportTracePartialSuccess",
      presence: true,
    },
  ],
  "opentelemetry.proto.common.v1.AnyValue": [
    {
      name: "string_value",
      json: "stringValue",
      id: 1,
      kind: "string",
      presence: true,
      oneof: "value",
    },
    {
      name: "bool_value",
      json: "boolValue",
      id: 2,
      kind: "bool",
      presence: true,
      oneof: "value",
    },
    {
      name: "int_value",
      json: "intValue",
      id: 3,
      kind: "int64",
      presence: true,
      oneof: "value",
    },
    {
      name: "double_value",
      json: "doubleValue",
      id: 4,
      kind: "double",
      presence: true,
      oneof: "value",
    },
    {
      name: "array_value",
      json: "arrayValue",
      id: 5,
      kind: "message",
      message: "opentelemetry.proto.common.v1.ArrayValue",
      presence: true,
      oneof: "value",
    },
    {
      name: "kvlist_value",
      json: "kvlistValue",
      id: 6,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValueList",
      presence: true,
      oneof: "value",
    },
    {
      name: "bytes_value",
      json: "bytesValue",
      id: 7,
      kind: "bytes",
      presence: true,
      oneof: "value",
    },
    {
      name: "string_value_strindex",
      json: "stringValueStrindex",
      id: 8,
      kind: "int32",
      presence: true,
      oneof: "value",
    },
  ],
  "opentelemetry.proto.common.v1.ArrayValue": [
    {
      name: "values",
      json: "values",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.AnyValue",
      repeated: true,
    },
  ],
  "opentelemetry.proto.common.v1.EntityRef": [
    { name: "schema_url", json: "schemaUrl", id: 1, kind: "string" },
    { name: "type", json: "type", id: 2, kind: "string" },
    { name: "id_keys", json: "idKeys", id: 3, kind: "string", repeated: true },
    {
      name: "description_keys",
      json: "descriptionKeys",
      id: 4,
      kind: "string",
      repeated: true,
    },
  ],
  "opentelemetry.proto.common.v1.InstrumentationScope": [
    { name: "name", json: "name", id: 1, kind: "string" },
    { name: "version", json: "version", id: 2, kind: "string" },
    {
      name: "attributes",
      json: "attributes",
      id: 3,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 4,
      kind: "uint32",
    },
  ],
  "opentelemetry.proto.common.v1.KeyValue": [
    { name: "key", json: "key", id: 1, kind: "string" },
    {
      name: "value",
      json: "value",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.common.v1.AnyValue",
      presence: true,
    },
    { name: "key_strindex", json: "keyStrindex", id: 3, kind: "int32" },
  ],
  "opentelemetry.proto.common.v1.KeyValueList": [
    {
      name: "values",
      json: "values",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
  ],
  "opentelemetry.proto.logs.v1.LogRecord": [
    { name: "time_unix_nano", json: "timeUnixNano", id: 1, kind: "fixed64" },
    {
      name: "severity_number",
      json: "severityNumber",
      id: 2,
      kind: "enum",
      enum: {
        SEVERITY_NUMBER_DEBUG: 5,
        SEVERITY_NUMBER_DEBUG2: 6,
        SEVERITY_NUMBER_DEBUG3: 7,
        SEVERITY_NUMBER_DEBUG4: 8,
        SEVERITY_NUMBER_ERROR: 17,
        SEVERITY_NUMBER_ERROR2: 18,
        SEVERITY_NUMBER_ERROR3: 19,
        SEVERITY_NUMBER_ERROR4: 20,
        SEVERITY_NUMBER_FATAL: 21,
        SEVERITY_NUMBER_FATAL2: 22,
        SEVERITY_NUMBER_FATAL3: 23,
        SEVERITY_NUMBER_FATAL4: 24,
        SEVERITY_NUMBER_INFO: 9,
        SEVERITY_NUMBER_INFO2: 10,
        SEVERITY_NUMBER_INFO3: 11,
        SEVERITY_NUMBER_INFO4: 12,
        SEVERITY_NUMBER_TRACE: 1,
        SEVERITY_NUMBER_TRACE2: 2,
        SEVERITY_NUMBER_TRACE3: 3,
        SEVERITY_NUMBER_TRACE4: 4,
        SEVERITY_NUMBER_UNSPECIFIED: 0,
        SEVERITY_NUMBER_WARN: 13,
        SEVERITY_NUMBER_WARN2: 14,
        SEVERITY_NUMBER_WARN3: 15,
        SEVERITY_NUMBER_WARN4: 16,
      },
    },
    { name: "severity_text", json: "severityText", id: 3, kind: "string" },
    {
      name: "body",
      json: "body",
      id: 5,
      kind: "message",
      message: "opentelemetry.proto.common.v1.AnyValue",
      presence: true,
    },
    {
      name: "attributes",
      json: "attributes",
      id: 6,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 7,
      kind: "uint32",
    },
    { name: "flags", json: "flags", id: 8, kind: "fixed32" },
    { name: "trace_id", json: "traceId", id: 9, kind: "bytes" },
    { name: "span_id", json: "spanId", id: 10, kind: "bytes" },
    {
      name: "observed_time_unix_nano",
      json: "observedTimeUnixNano",
      id: 11,
      kind: "fixed64",
    },
    { name: "event_name", json: "eventName", id: 12, kind: "string" },
  ],
  "opentelemetry.proto.logs.v1.ResourceLogs": [
    {
      name: "resource",
      json: "resource",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.resource.v1.Resource",
      presence: true,
    },
    {
      name: "scope_logs",
      json: "scopeLogs",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.logs.v1.ScopeLogs",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.logs.v1.ScopeLogs": [
    {
      name: "scope",
      json: "scope",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.InstrumentationScope",
      presence: true,
    },
    {
      name: "log_records",
      json: "logRecords",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.logs.v1.LogRecord",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.metrics.v1.Exemplar": [
    { name: "time_unix_nano", json: "timeUnixNano", id: 2, kind: "fixed64" },
    {
      name: "as_double",
      json: "asDouble",
      id: 3,
      kind: "double",
      presence: true,
      oneof: "value",
    },
    { name: "span_id", json: "spanId", id: 4, kind: "bytes" },
    { name: "trace_id", json: "traceId", id: 5, kind: "bytes" },
    {
      name: "as_int",
      json: "asInt",
      id: 6,
      kind: "sfixed64",
      presence: true,
      oneof: "value",
    },
    {
      name: "filtered_attributes",
      json: "filteredAttributes",
      id: 7,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
  ],
  "opentelemetry.proto.metrics.v1.ExponentialHistogram": [
    {
      name: "data_points",
      json: "dataPoints",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint",
      repeated: true,
    },
    {
      name: "aggregation_temporality",
      json: "aggregationTemporality",
      id: 2,
      kind: "enum",
      enum: {
        AGGREGATION_TEMPORALITY_CUMULATIVE: 2,
        AGGREGATION_TEMPORALITY_DELTA: 1,
        AGGREGATION_TEMPORALITY_UNSPECIFIED: 0,
      },
    },
  ],
  "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint": [
    {
      name: "attributes",
      json: "attributes",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "start_time_unix_nano",
      json: "startTimeUnixNano",
      id: 2,
      kind: "fixed64",
    },
    { name: "time_unix_nano", json: "timeUnixNano", id: 3, kind: "fixed64" },
    { name: "count", json: "count", id: 4, kind: "fixed64" },
    {
      name: "sum",
      json: "sum",
      id: 5,
      kind: "double",
      presence: true,
      oneof: "_sum",
    },
    { name: "scale", json: "scale", id: 6, kind: "sint32" },
    { name: "zero_count", json: "zeroCount", id: 7, kind: "fixed64" },
    {
      name: "positive",
      json: "positive",
      id: 8,
      kind: "message",
      message:
        "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint.Buckets",
      presence: true,
    },
    {
      name: "negative",
      json: "negative",
      id: 9,
      kind: "message",
      message:
        "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint.Buckets",
      presence: true,
    },
    { name: "flags", json: "flags", id: 10, kind: "uint32" },
    {
      name: "exemplars",
      json: "exemplars",
      id: 11,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Exemplar",
      repeated: true,
    },
    {
      name: "min",
      json: "min",
      id: 12,
      kind: "double",
      presence: true,
      oneof: "_min",
    },
    {
      name: "max",
      json: "max",
      id: 13,
      kind: "double",
      presence: true,
      oneof: "_max",
    },
    { name: "zero_threshold", json: "zeroThreshold", id: 14, kind: "double" },
  ],
  "opentelemetry.proto.metrics.v1.ExponentialHistogramDataPoint.Buckets": [
    { name: "offset", json: "offset", id: 1, kind: "sint32" },
    {
      name: "bucket_counts",
      json: "bucketCounts",
      id: 2,
      kind: "uint64",
      repeated: true,
      packed: true,
    },
  ],
  "opentelemetry.proto.metrics.v1.Gauge": [
    {
      name: "data_points",
      json: "dataPoints",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.NumberDataPoint",
      repeated: true,
    },
  ],
  "opentelemetry.proto.metrics.v1.Histogram": [
    {
      name: "data_points",
      json: "dataPoints",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.HistogramDataPoint",
      repeated: true,
    },
    {
      name: "aggregation_temporality",
      json: "aggregationTemporality",
      id: 2,
      kind: "enum",
      enum: {
        AGGREGATION_TEMPORALITY_CUMULATIVE: 2,
        AGGREGATION_TEMPORALITY_DELTA: 1,
        AGGREGATION_TEMPORALITY_UNSPECIFIED: 0,
      },
    },
  ],
  "opentelemetry.proto.metrics.v1.HistogramDataPoint": [
    {
      name: "start_time_unix_nano",
      json: "startTimeUnixNano",
      id: 2,
      kind: "fixed64",
    },
    { name: "time_unix_nano", json: "timeUnixNano", id: 3, kind: "fixed64" },
    { name: "count", json: "count", id: 4, kind: "fixed64" },
    {
      name: "sum",
      json: "sum",
      id: 5,
      kind: "double",
      presence: true,
      oneof: "_sum",
    },
    {
      name: "bucket_counts",
      json: "bucketCounts",
      id: 6,
      kind: "fixed64",
      repeated: true,
      packed: true,
    },
    {
      name: "explicit_bounds",
      json: "explicitBounds",
      id: 7,
      kind: "double",
      repeated: true,
      packed: true,
    },
    {
      name: "exemplars",
      json: "exemplars",
      id: 8,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Exemplar",
      repeated: true,
    },
    {
      name: "attributes",
      json: "attributes",
      id: 9,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    { name: "flags", json: "flags", id: 10, kind: "uint32" },
    {
      name: "min",
      json: "min",
      id: 11,
      kind: "double",
      presence: true,
      oneof: "_min",
    },
    {
      name: "max",
      json: "max",
      id: 12,
      kind: "double",
      presence: true,
      oneof: "_max",
    },
  ],
  "opentelemetry.proto.metrics.v1.Metric": [
    { name: "name", json: "name", id: 1, kind: "string" },
    { name: "description", json: "description", id: 2, kind: "string" },
    { name: "unit", json: "unit", id: 3, kind: "string" },
    {
      name: "gauge",
      json: "gauge",
      id: 5,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Gauge",
      presence: true,
      oneof: "data",
    },
    {
      name: "sum",
      json: "sum",
      id: 7,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Sum",
      presence: true,
      oneof: "data",
    },
    {
      name: "histogram",
      json: "histogram",
      id: 9,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Histogram",
      presence: true,
      oneof: "data",
    },
    {
      name: "exponential_histogram",
      json: "exponentialHistogram",
      id: 10,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.ExponentialHistogram",
      presence: true,
      oneof: "data",
    },
    {
      name: "summary",
      json: "summary",
      id: 11,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Summary",
      presence: true,
      oneof: "data",
    },
    {
      name: "metadata",
      json: "metadata",
      id: 12,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
  ],
  "opentelemetry.proto.metrics.v1.NumberDataPoint": [
    {
      name: "start_time_unix_nano",
      json: "startTimeUnixNano",
      id: 2,
      kind: "fixed64",
    },
    { name: "time_unix_nano", json: "timeUnixNano", id: 3, kind: "fixed64" },
    {
      name: "as_double",
      json: "asDouble",
      id: 4,
      kind: "double",
      presence: true,
      oneof: "value",
    },
    {
      name: "exemplars",
      json: "exemplars",
      id: 5,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Exemplar",
      repeated: true,
    },
    {
      name: "as_int",
      json: "asInt",
      id: 6,
      kind: "sfixed64",
      presence: true,
      oneof: "value",
    },
    {
      name: "attributes",
      json: "attributes",
      id: 7,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    { name: "flags", json: "flags", id: 8, kind: "uint32" },
  ],
  "opentelemetry.proto.metrics.v1.ResourceMetrics": [
    {
      name: "resource",
      json: "resource",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.resource.v1.Resource",
      presence: true,
    },
    {
      name: "scope_metrics",
      json: "scopeMetrics",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.ScopeMetrics",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.metrics.v1.ScopeMetrics": [
    {
      name: "scope",
      json: "scope",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.InstrumentationScope",
      presence: true,
    },
    {
      name: "metrics",
      json: "metrics",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.Metric",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.metrics.v1.Sum": [
    {
      name: "data_points",
      json: "dataPoints",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.NumberDataPoint",
      repeated: true,
    },
    {
      name: "aggregation_temporality",
      json: "aggregationTemporality",
      id: 2,
      kind: "enum",
      enum: {
        AGGREGATION_TEMPORALITY_CUMULATIVE: 2,
        AGGREGATION_TEMPORALITY_DELTA: 1,
        AGGREGATION_TEMPORALITY_UNSPECIFIED: 0,
      },
    },
    { name: "is_monotonic", json: "isMonotonic", id: 3, kind: "bool" },
  ],
  "opentelemetry.proto.metrics.v1.Summary": [
    {
      name: "data_points",
      json: "dataPoints",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.metrics.v1.SummaryDataPoint",
      repeated: true,
    },
  ],
  "opentelemetry.proto.metrics.v1.SummaryDataPoint": [
    {
      name: "start_time_unix_nano",
      json: "startTimeUnixNano",
      id: 2,
      kind: "fixed64",
    },
    { name: "time_unix_nano", json: "timeUnixNano", id: 3, kind: "fixed64" },
    { name: "count", json: "count", id: 4, kind: "fixed64" },
    { name: "sum", json: "sum", id: 5, kind: "double" },
    {
      name: "quantile_values",
      json: "quantileValues",
      id: 6,
      kind: "message",
      message:
        "opentelemetry.proto.metrics.v1.SummaryDataPoint.ValueAtQuantile",
      repeated: true,
    },
    {
      name: "attributes",
      json: "attributes",
      id: 7,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    { name: "flags", json: "flags", id: 8, kind: "uint32" },
  ],
  "opentelemetry.proto.metrics.v1.SummaryDataPoint.ValueAtQuantile": [
    { name: "quantile", json: "quantile", id: 1, kind: "double" },
    { name: "value", json: "value", id: 2, kind: "double" },
  ],
  "opentelemetry.proto.resource.v1.Resource": [
    {
      name: "attributes",
      json: "attributes",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 2,
      kind: "uint32",
    },
    {
      name: "entity_refs",
      json: "entityRefs",
      id: 3,
      kind: "message",
      message: "opentelemetry.proto.common.v1.EntityRef",
      repeated: true,
    },
  ],
  "opentelemetry.proto.trace.v1.ResourceSpans": [
    {
      name: "resource",
      json: "resource",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.resource.v1.Resource",
      presence: true,
    },
    {
      name: "scope_spans",
      json: "scopeSpans",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.ScopeSpans",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.trace.v1.ScopeSpans": [
    {
      name: "scope",
      json: "scope",
      id: 1,
      kind: "message",
      message: "opentelemetry.proto.common.v1.InstrumentationScope",
      presence: true,
    },
    {
      name: "spans",
      json: "spans",
      id: 2,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.Span",
      repeated: true,
    },
    { name: "schema_url", json: "schemaUrl", id: 3, kind: "string" },
  ],
  "opentelemetry.proto.trace.v1.Span": [
    { name: "trace_id", json: "traceId", id: 1, kind: "bytes" },
    { name: "span_id", json: "spanId", id: 2, kind: "bytes" },
    { name: "trace_state", json: "traceState", id: 3, kind: "string" },
    { name: "parent_span_id", json: "parentSpanId", id: 4, kind: "bytes" },
    { name: "name", json: "name", id: 5, kind: "string" },
    {
      name: "kind",
      json: "kind",
      id: 6,
      kind: "enum",
      enum: {
        SPAN_KIND_CLIENT: 3,
        SPAN_KIND_CONSUMER: 5,
        SPAN_KIND_INTERNAL: 1,
        SPAN_KIND_PRODUCER: 4,
        SPAN_KIND_SERVER: 2,
        SPAN_KIND_UNSPECIFIED: 0,
      },
    },
    {
      name: "start_time_unix_nano",
      json: "startTimeUnixNano",
      id: 7,
      kind: "fixed64",
    },
    {
      name: "end_time_unix_nano",
      json: "endTimeUnixNano",
      id: 8,
      kind: "fixed64",
    },
    {
      name: "attributes",
      json: "attributes",
      id: 9,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 10,
      kind: "uint32",
    },
    {
      name: "events",
      json: "events",
      id: 11,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.Span.Event",
      repeated: true,
    },
    {
      name: "dropped_events_count",
      json: "droppedEventsCount",
      id: 12,
      kind: "uint32",
    },
    {
      name: "links",
      json: "links",
      id: 13,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.Span.Link",
      repeated: true,
    },
    {
      name: "dropped_links_count",
      json: "droppedLinksCount",
      id: 14,
      kind: "uint32",
    },
    {
      name: "status",
      json: "status",
      id: 15,
      kind: "message",
      message: "opentelemetry.proto.trace.v1.Status",
      presence: true,
    },
    { name: "flags", json: "flags", id: 16, kind: "fixed32" },
  ],
  "opentelemetry.proto.trace.v1.Span.Event": [
    { name: "time_unix_nano", json: "timeUnixNano", id: 1, kind: "fixed64" },
    { name: "name", json: "name", id: 2, kind: "string" },
    {
      name: "attributes",
      json: "attributes",
      id: 3,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 4,
      kind: "uint32",
    },
  ],
  "opentelemetry.proto.trace.v1.Span.Link": [
    { name: "trace_id", json: "traceId", id: 1, kind: "bytes" },
    { name: "span_id", json: "spanId", id: 2, kind: "bytes" },
    { name: "trace_state", json: "traceState", id: 3, kind: "string" },
    {
      name: "attributes",
      json: "attributes",
      id: 4,
      kind: "message",
      message: "opentelemetry.proto.common.v1.KeyValue",
      repeated: true,
    },
    {
      name: "dropped_attributes_count",
      json: "droppedAttributesCount",
      id: 5,
      kind: "uint32",
    },
    { name: "flags", json: "flags", id: 6, kind: "fixed32" },
  ],
  "opentelemetry.proto.trace.v1.Status": [
    { name: "message", json: "message", id: 2, kind: "string" },
    {
      name: "code",
      json: "code",
      id: 3,
      kind: "enum",
      enum: { STATUS_CODE_ERROR: 2, STATUS_CODE_OK: 1, STATUS_CODE_UNSET: 0 },
    },
  ],
};
const unknownFields = Symbol("protobuf unknown fields");
const floatBits = Symbol("protobuf NaN bits");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const scalar64 = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
const hexField = (f: Field) =>
  ["traceId", "spanId", "parentSpanId"].includes(f.json);
const requestName = (s: Signal) => {
  const stem = s === "traces" ? "trace" : s;
  return `opentelemetry.proto.collector.${stem}.v1.Export${stem[0].toUpperCase() + stem.slice(1)}ServiceRequest`;
};
const responseName = (s: Signal) =>
  requestName(s).replace(/Request$/, "Response");
function integer(value: any, kind: string): string | number {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw Error("unsafe protobuf integer");
  let text = integerString(value);
  if (!/^-?\d+$/.test(text)) {
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!match) throw Error("invalid protobuf integer");
    const fraction = match[3] ?? "",
      exponent = Number(match[4] ?? 0),
      shift = exponent - fraction.length;
    if (Math.abs(shift) > 100) throw Error("protobuf integer out of range");
    let digits = match[2] + fraction;
    if (shift < 0) {
      if (!digits.endsWith("0".repeat(-shift)))
        throw Error("fractional protobuf integer");
      digits = digits.slice(0, shift) || "0";
    } else digits += "0".repeat(shift);
    text = match[1] + digits;
  }
  const n = BigInt(text);
  const unsigned =
    kind === "uint64" ||
    kind === "fixed64" ||
    kind === "uint32" ||
    kind === "fixed32";
  const bits = scalar64.has(kind) ? 64n : 32n;
  if (
    n < (unsigned ? 0n : -(1n << (bits - 1n))) ||
    n > (unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n)
  )
    throw Error("protobuf integer out of range");
  return bits === 64n ? n.toString() : Number(n);
}
function normalize(name: string, obj: any): any {
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw Error("protobuf message must be an object");
  const output: any = {};
  const fields = schema[name];
  if (!fields) throw Error("unknown protobuf message");
  const oneofs = new Set<string>();
  for (const key of Object.keys(obj)) {
    const field = fields.find((f) => f.json === key || f.name === key);
    if (!field) throw Error(`unknown protobuf field: ${key}`);
    if (obj[key] === null) continue;
    if (Object.hasOwn(output, field.json))
      throw Error("duplicate protobuf field");
    if (field.oneof) {
      if (oneofs.has(field.oneof)) throw Error("multiple oneof values");
      oneofs.add(field.oneof);
    }
    const convert = (v: any): any => {
      if (field.message) return normalize(field.message, v);
      if (field.kind === "bytes") {
        if (v instanceof Uint8Array) return Buffer.from(v);
        if (typeof v !== "string") throw Error("bytes must be a string");
        if (hexField(field)) {
          if (
            v !== "" &&
            (!/^[0-9a-fA-F]+$/.test(v) ||
              v.length !== (field.json === "traceId" ? 32 : 16))
          )
            throw Error("invalid trace or span ID");
          return v.toLowerCase();
        }
        if (!/^[a-zA-Z0-9+/_-]*={0,2}$/.test(v) || v.length % 4 === 1)
          throw Error("invalid base64");
        return v;
      }
      if (field.kind === "string") {
        if (typeof v !== "string") throw Error("protobuf string required");
        return v;
      }
      if (field.kind === "bool") {
        if (typeof v !== "boolean") throw Error("protobuf boolean required");
        return v;
      }
      if (field.kind === "enum") {
        if (typeof v === "string" && field.enum && Object.hasOwn(field.enum, v))
          return field.enum[v];
        return integer(v, "int32");
      }
      if (field.kind === "float" || field.kind === "double") {
        const n =
          typeof v === "string" && ["NaN", "Infinity", "-Infinity"].includes(v)
            ? Number(v)
            : Number(integerString(v));
        if (
          !Number.isFinite(n) &&
          !["NaN", "Infinity", "-Infinity"].includes(String(v))
        )
          throw Error("invalid floating point");
        return n;
      }
      return integer(v, field.kind);
    };
    if (field.repeated) {
      if (!Array.isArray(obj[key]) || obj[key].some((x: any) => x === null))
        throw Error("protobuf repeated field must be an array");
      output[field.json] = obj[key].map(convert);
    } else output[field.json] = convert(obj[key]);
  }
  if (obj[unknownFields]) output[unknownFields] = obj[unknownFields];
  if (obj[floatBits]) output[floatBits] = obj[floatBits];
  return output;
}
function readMessage(name: string, reader: protobuf.Reader, end: number): any {
  const out: any = {};
  const fields = schema[name];
  const unknown: Buffer[] = [];
  while (reader.pos < end) {
    const start = reader.pos,
      tag = reader.uint32(),
      wire = tag & 7,
      id = tag >>> 3;
    if (id === 0) throw Error("invalid protobuf tag");
    const field = fields.find((f) => f.id === id);
    if (!field) {
      reader.skipType(wire);
      unknown.push(Buffer.from(reader.buf.subarray(start, reader.pos)));
      continue;
    }
    const expected =
      field.message || field.kind === "string" || field.kind === "bytes"
        ? 2
        : ["double", "fixed64", "sfixed64"].includes(field.kind)
          ? 1
          : ["float", "fixed32", "sfixed32"].includes(field.kind)
            ? 5
            : 0;
    if (wire !== expected && !(field.repeated && field.packed && wire === 2))
      throw Error("invalid protobuf wire type");
    const read = (): any => {
      if (field.message) {
        const size = reader.uint32();
        return readMessage(field.message, reader, reader.pos + size);
      }
      if (field.kind === "bytes") {
        const data = reader.bytes();
        return Buffer.from(data).toString(hexField(field) ? "hex" : "base64");
      }
      if (field.kind === "string") return utf8.decode(reader.bytes());
      const method = field.kind === "enum" ? "int32" : field.kind;
      const position = reader.pos,
        value = (reader as any)[method]();
      if (typeof value === "number" && Number.isNaN(value)) {
        const bits = (out[floatBits] ??= {});
        (bits[field.json] ??= [])[
          field.repeated ? (out[field.json]?.length ?? 0) : 0
        ] = Buffer.from(reader.buf.subarray(position, reader.pos));
      } else if (!field.repeated && out[floatBits])
        delete out[floatBits][field.json];
      return scalar64.has(field.kind) ? value.toString() : value;
    };
    if (field.repeated) {
      const list = (out[field.json] ??= []);
      if (wire === 2 && field.packed) {
        const size = reader.uint32(),
          limit = reader.pos + size;
        if (limit > end) throw Error("truncated packed field");
        while (reader.pos < limit) list.push(read());
        if (reader.pos !== limit) throw Error("invalid packed field");
      } else list.push(read());
    } else {
      const previous = out[field.json],
        value = read();
      if (field.oneof)
        for (const f of fields)
          if (f.oneof === field.oneof && f.json !== field.json)
            delete out[f.json];
      out[field.json] =
        field.message && previous
          ? mergeMessage(field.message, previous, value)
          : value;
    }
  }
  if (reader.pos !== end) throw Error("truncated protobuf message");
  if (unknown.length)
    Object.defineProperty(out, unknownFields, {
      value: unknown,
      writable: true,
    });
  return out;
}
function mergeMessage(name: string, target: any, source: any): any {
  for (const f of schema[name]) {
    if (source[f.json] === undefined) continue;
    if (f.oneof)
      for (const other of schema[name])
        if (other.oneof === f.oneof && other.json !== f.json)
          delete target[other.json];
    if (f.repeated)
      target[f.json] = [...(target[f.json] ?? []), ...source[f.json]];
    else if (f.message && target[f.json])
      target[f.json] = mergeMessage(f.message, target[f.json], source[f.json]);
    else target[f.json] = source[f.json];
  }
  if (source[floatBits])
    target[floatBits] = { ...target[floatBits], ...source[floatBits] };
  if (source[unknownFields]) {
    const bytes = [...(target[unknownFields] ?? []), ...source[unknownFields]];
    if (target[unknownFields]) target[unknownFields] = bytes;
    else
      Object.defineProperty(target, unknownFields, {
        value: bytes,
        writable: true,
      });
  }
  return target;
}
function writeMessage(name: string, obj: any, writer: protobuf.Writer): void {
  for (const f of schema[name]) {
    const value = obj[f.json];
    if (value === undefined || value === null) continue;
    const values = f.repeated ? value : [value];
    if (!values.length) continue;
    const scalar = (v: any, index: number) => {
      if (typeof v === "number" && Number.isNaN(v)) {
        writer.raw(
          obj[floatBits]?.[f.json]?.[index] ??
            Buffer.from(
              f.kind === "float" ? "0000c07f" : "010000000000f87f",
              "hex",
            ),
        );
      } else (writer as any)[f.kind === "enum" ? "int32" : f.kind](v);
    };
    const emit = (v: any, index: number) => {
      if (f.message) {
        const child = writer.uint32(f.id * 8 + 2).fork();
        writeMessage(f.message, v, child);
        child.ldelim();
        return;
      }
      const kind = f.kind === "enum" ? "int32" : f.kind;
      const wire =
        kind === "bytes" || kind === "string"
          ? 2
          : ["double", "fixed64", "sfixed64"].includes(kind)
            ? 1
            : ["float", "fixed32", "sfixed32"].includes(kind)
              ? 5
              : 0;
      writer.uint32(f.id * 8 + wire);
      if (kind === "bytes") {
        (writer as any).bytes(
          v instanceof Uint8Array
            ? v
            : Buffer.from(v, hexField(f) ? "hex" : "base64"),
        );
      } else scalar(v, index);
    };
    if (f.repeated && f.packed) {
      writer.uint32(f.id * 8 + 2).fork();
      for (let i = 0; i < values.length; i++) scalar(values[i], i);
      writer.ldelim();
    } else
      for (const [index, v] of values.entries()) {
        if (
          !f.repeated &&
          !f.presence &&
          !f.message &&
          (v === false || v === "" || v === 0 || v === "0") &&
          !Object.is(v, -0)
        )
          continue;
        emit(v, index);
      }
  }
  for (const bytes of obj[unknownFields] ?? []) writer.raw(bytes);
}
function encode(name: string, obj: any): Buffer {
  const normalized = normalize(name, obj),
    writer = protobuf.Writer.create();
  writeMessage(name, normalized, writer);
  return Buffer.from(writer.finish());
}
function decode(name: string, data: Uint8Array, contentType: string): any {
  if (contentType.split(";")[0].trim().toLowerCase() === "application/json")
    return normalize(name, parseJSON(Buffer.from(data).toString("utf8")));
  if (
    contentType.split(";")[0].trim().toLowerCase() !== "application/x-protobuf"
  )
    throw Error("unsupported Content-Type");
  const reader = protobuf.Reader.create(data);
  return readMessage(name, reader, data.length);
}
export function decodeOTLP(
  signal: Signal,
  data: Uint8Array,
  contentType: string,
): any {
  return decode(requestName(signal), data, contentType);
}
export function encodeOTLP(signal: Signal, obj: any): Buffer {
  return encode(requestName(signal), obj);
}
export function decodeOTLPResponse(
  signal: Signal,
  data: Uint8Array,
  contentType = "application/x-protobuf",
): any {
  return decode(responseName(signal), data, contentType);
}
export function encodeOTLPResponse(signal: Signal, obj: any): Buffer {
  return encode(responseName(signal), obj);
}
export function resources(signal: Signal, obj: any): any[] {
  const key =
    signal === "logs"
      ? "resourceLogs"
      : signal === "metrics"
        ? "resourceMetrics"
        : "resourceSpans";
  return (obj[key] ?? []).map(
    (item: any) => item.resource ?? (item.resource = {}),
  );
}
export function resourceString(resource: any, key: string): string {
  return (
    resource.attributes?.find((a: any) => a.key === key)?.value?.stringValue ??
    ""
  );
}
export function resourceSet(resource: any, key: string, value: string): void {
  const attrs = (resource.attributes ??= []);
  let found = false;
  for (const a of attrs)
    if (a.key === key) {
      a.value = { stringValue: value };
      found = true;
    }
  if (!found) attrs.push({ key, value: { stringValue: value } });
}
export function nowNano(): bigint {
  return BigInt(Date.now()) * 1000000n;
}
export function parseNanoTime(value: string): bigint {
  const m =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:[.,](\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
  if (!m) throw Error("valid RFC3339 time required");
  const local = Date.parse(m[1] + "Z"),
    ms = Date.parse(m[1] + m[3]);
  if (
    !Number.isFinite(ms) ||
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 19) !== m[1]
  )
    throw Error("invalid time");
  return BigInt(ms) * 1000000n + BigInt((m[2] ?? "").padEnd(9, "0"));
}
export function formatNanoTime(value: bigint | string | number): string {
  const ns = BigInt(value),
    seconds = ns >= 0n ? ns / 1000000000n : (ns - 999999999n) / 1000000000n,
    remainder = ns - seconds * 1000000000n;
  const base = new Date(Number(seconds * 1000n)).toISOString().slice(0, 19);
  const fractional = remainder.toString().padStart(9, "0").replace(/0+$/, "");
  return base + (fractional ? "." + fractional : "") + "Z";
}
export function inputHash(
  signal: Signal,
  table: string,
  createdAt: string,
  obj: any,
): string {
  return createHash("sha256")
    .update(
      `${signal}\0${table}\0${formatNanoTime(parseNanoTime(createdAt))}\0`,
    )
    .update(encodeOTLP(signal, obj))
    .digest("hex");
}
/** Deterministic lossless JSON for current hashes and telemetry columns. */
export function stableJSON(value: any, sortedMaps = false): string {
  const order = (v: any): any => {
    if (!v || typeof v !== 'object' || v.isLosslessNumber === true) return v;
    if (Array.isArray(v)) return v.map(order);
    return Object.fromEntries(Object.keys(v).sort().map(key => [key, order(v[key])]));
  };
  return stringifyJSON(sortedMaps ? order(value) : value);
}
