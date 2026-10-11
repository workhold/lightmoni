package ingest

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/shared"
	logs "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metrics "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	traces "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	common "go.opentelemetry.io/proto/otlp/common/v1"
	metric "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Ingest struct {
	Catalog *Catalog
	Auth    *auth.Auth
	mu      sync.Mutex
}
type normalized struct {
	Kind, Subtype string
	Row           map[string]any
}

func anyValue(v *common.AnyValue) any {
	if v == nil {
		return nil
	}
	switch x := v.Value.(type) {
	case *common.AnyValue_StringValue:
		return x.StringValue
	case *common.AnyValue_BoolValue:
		return x.BoolValue
	case *common.AnyValue_IntValue:
		return x.IntValue
	case *common.AnyValue_DoubleValue:
		return x.DoubleValue
	case *common.AnyValue_ArrayValue:
		r := []any{}
		for _, v := range x.ArrayValue.Values {
			r = append(r, anyValue(v))
		}
		return r
	case *common.AnyValue_KvlistValue:
		return attrs(x.KvlistValue.Values)
	case *common.AnyValue_BytesValue:
		return hex.EncodeToString(x.BytesValue)
	}
	return nil
}
func attrs(values []*common.KeyValue) map[string]any {
	m := map[string]any{}
	for _, v := range values {
		m[v.Key] = anyValue(v.Value)
	}
	return m
}
func jsonText(v any) string { b, _ := json.Marshal(v); return string(b) }
func textAttrs(m map[string]any) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		if s, ok := v.(string); ok {
			out[k] = s
		} else {
			out[k] = jsonText(v)
		}
	}
	return out
}
func stamp(n uint64) string {
	if n == 0 {
		return "1970-01-01 00:00:00.000000000"
	}
	return time.Unix(0, int64(n)).UTC().Format("2006-01-02 15:04:05.000000000")
}
func nullableFloat(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}
func number(p *metric.NumberDataPoint) (string, string, error) {
	switch v := p.Value.(type) {
	case *metric.NumberDataPoint_AsInt:
		return strconv.FormatInt(v.AsInt, 10), "int", nil
	case *metric.NumberDataPoint_AsDouble:
		if math.IsNaN(v.AsDouble) || math.IsInf(v.AsDouble, 0) {
			return "", "", errors.New("metric value must be finite")
		}
		legacy := "0"
		if math.Abs(v.AsDouble) < 1e29 {
			legacy = strconv.FormatFloat(v.AsDouble, 'f', 9, 64)
		}
		return legacy, "double", nil
	}
	return "", "", errors.New("missing metric value")
}
func base(resource map[string]any, attributes []*common.KeyValue, n uint64, received, key string) map[string]any {
	a := attrs(attributes)
	return map[string]any{"event_time": stamp(n), "ingested_at": received, "service": fmt.Sprint(resource["service.name"]), "instance_id": str(resource["service.instance.id"]), "host_id": str(resource["host.id"]), "agent_id": str(resource["lightmoni.agent_id"]), "key_id": key, "resource_json": jsonText(resource), "attributes": textAttrs(a), "attributes_json": jsonText(a)}
}
func str(v any) string {
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func decode(raw []byte, contentType string, v proto.Message) error {
	if strings.Contains(contentType, "json") {
		var body any
		if err := json.Unmarshal(raw, &body); err != nil {
			return err
		}
		if err := convertOTLPIDs(body); err != nil {
			return err
		}
		normalized, err := json.Marshal(body)
		if err != nil {
			return err
		}
		return protojson.Unmarshal(normalized, v)
	}
	return proto.Unmarshal(raw, v)
}
func normalize(signal string, raw []byte, contentType, received, key string) ([]normalized, error) {
	out := []normalized{}
	switch signal {
	case "logs":
		var req logs.ExportLogsServiceRequest
		if e := decode(raw, contentType, &req); e != nil {
			return nil, e
		}
		for _, rs := range req.ResourceLogs {
			resource := attrs(rs.GetResource().GetAttributes())
			for _, scope := range rs.ScopeLogs {
				for _, log := range scope.LogRecords {
					at := log.TimeUnixNano
					if at == 0 {
						at = log.ObservedTimeUnixNano
					}
					if at == 0 {
						if t, e := time.Parse("2006-01-02 15:04:05.000000000", received); e == nil {
							at = uint64(t.UnixNano())
						}
					}
					row := base(resource, log.Attributes, at, received, key)
					row["severity"] = log.SeverityText
					if row["severity"] == "" {
						n := int(log.SeverityNumber)
						row["severity"] = []string{"UNSPECIFIED", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"}[min(6, (n+3)/4)]
					}
					row["severity_number"] = int(log.SeverityNumber)
					body := anyValue(log.Body)
					row["body"] = str(body)
					if _, ok := body.(string); !ok {
						row["body"] = jsonText(body)
					}
					row["body_json"] = jsonText(body)
					row["trace_id"] = hex.EncodeToString(log.TraceId)
					row["span_id"] = hex.EncodeToString(log.SpanId)
					a := attrs(log.Attributes)
					source := str(a["lightmoni.source_id"])
					if source == "" {
						source = str(resource["service.instance.id"])
					}
					row["source_id"] = source
					var seq any
					if v, ok := a["lightmoni.source_seq"]; ok {
						seq = v
					}
					row["source_seq"] = seq
					out = append(out, normalized{Kind: "log", Row: row})
				}
			}
		}
	case "metrics":
		var req metrics.ExportMetricsServiceRequest
		if e := decode(raw, contentType, &req); e != nil {
			return nil, e
		}
		for _, rs := range req.ResourceMetrics {
			resource := attrs(rs.GetResource().GetAttributes())
			for _, scope := range rs.ScopeMetrics {
				for _, m := range scope.Metrics {
					var points []*metric.NumberDataPoint
					subtype := ""
					temporality := ""
					monotonic := false
					switch data := m.Data.(type) {
					case *metric.Metric_Sum:
						points = data.Sum.DataPoints
						subtype = "sum"
						temporality = strings.TrimPrefix(data.Sum.AggregationTemporality.String(), "AGGREGATION_TEMPORALITY_")
						monotonic = data.Sum.IsMonotonic
					case *metric.Metric_Gauge:
						points = data.Gauge.DataPoints
						subtype = "gauge"
					case *metric.Metric_Histogram:
						for _, p := range data.Histogram.DataPoints {
							if len(p.BucketCounts) != len(p.ExplicitBounds)+1 {
								return nil, errors.New("invalid histogram buckets")
							}
							var total uint64
							for _, v := range p.BucketCounts {
								if math.MaxUint64-total < v {
									return nil, errors.New("histogram count overflow")
								}
								total += v
							}
							if total != p.Count {
								return nil, errors.New("histogram count mismatch")
							}
							for i, v := range p.ExplicitBounds {
								if math.IsInf(v, 0) || math.IsNaN(v) || i > 0 && v <= p.ExplicitBounds[i-1] {
									return nil, errors.New("invalid histogram bounds")
								}
							}
							for _, v := range []*float64{p.Sum, p.Min, p.Max} {
								if v != nil && (math.IsNaN(*v) || math.IsInf(*v, 0)) {
									return nil, errors.New("histogram values must be finite")
								}
							}
							row := base(resource, p.Attributes, p.TimeUnixNano, received, key)
							row["name"] = m.Name
							row["unit"] = m.Unit
							row["start_time"] = stamp(p.StartTimeUnixNano)
							row["bounds"] = p.ExplicitBounds
							if row["bounds"] == nil {
								row["bounds"] = []float64{}
							}
							row["bucket_counts"] = p.BucketCounts
							row["count"] = strconv.FormatUint(p.Count, 10)
							row["sum"] = nullableFloat(p.Sum)
							row["min"] = nullableFloat(p.Min)
							row["max"] = nullableFloat(p.Max)
							row["temporality"] = strings.TrimPrefix(data.Histogram.AggregationTemporality.String(), "AGGREGATION_TEMPORALITY_")
							out = append(out, normalized{Kind: "metric", Subtype: "histogram", Row: row})
						}
						continue
					default:
						return nil, errors.New("unsupported metric type; use Sum/Gauge/explicit Histogram")
					}
					for _, p := range points {
						value, typ, e := number(p)
						if e != nil {
							return nil, e
						}
						row := base(resource, p.Attributes, p.TimeUnixNano, received, key)
						row["name"] = m.Name
						row["unit"] = m.Unit
						row["start_time"] = stamp(p.StartTimeUnixNano)
						row["value"] = value
						row["value_type"] = typ
						row["value_int"] = nil
						switch v := p.Value.(type) {
						case *metric.NumberDataPoint_AsInt:
							row["value_int"] = strconv.FormatInt(v.AsInt, 10)
							row["value_float"] = float64(v.AsInt)
						case *metric.NumberDataPoint_AsDouble:
							row["value_float"] = v.AsDouble
						}
						if subtype == "sum" {
							row["temporality"] = temporality
							row["monotonic"] = monotonic
						}
						out = append(out, normalized{Kind: "metric", Subtype: subtype, Row: row})
					}
				}
			}
		}
	case "traces":
		var req traces.ExportTraceServiceRequest
		if e := decode(raw, contentType, &req); e != nil {
			return nil, e
		}
		for _, rs := range req.ResourceSpans {
			resource := attrs(rs.GetResource().GetAttributes())
			for _, scope := range rs.ScopeSpans {
				for _, span := range scope.Spans {
					if len(span.TraceId) != 16 || len(span.SpanId) != 8 || (len(span.ParentSpanId) != 0 && len(span.ParentSpanId) != 8) {
						return nil, errors.New("invalid span IDs")
					}
					if span.EndTimeUnixNano < span.StartTimeUnixNano {
						return nil, errors.New("invalid span duration")
					}
					row := base(resource, span.Attributes, span.StartTimeUnixNano, received, key)
					row["trace_id"] = hex.EncodeToString(span.TraceId)
					row["span_id"] = hex.EncodeToString(span.SpanId)
					row["parent_span_id"] = hex.EncodeToString(span.ParentSpanId)
					row["name"] = span.Name
					row["kind"] = span.Kind.String()
					row["start_time"] = stamp(span.StartTimeUnixNano)
					row["end_time"] = stamp(span.EndTimeUnixNano)
					row["duration_ns"] = strconv.FormatUint(span.EndTimeUnixNano-span.StartTimeUnixNano, 10)
					row["status"] = span.GetStatus().GetCode().String()
					row["events_json"] = jsonText(span.Events)
					row["links_json"] = jsonText(span.Links)
					out = append(out, normalized{Kind: "trace", Row: row})
				}
			}
		}
	default:
		return nil, errors.New("unknown signal")
	}
	for _, r := range out {
		if r.Row["service"] == "" || r.Row["service"] == "<nil>" {
			return nil, errors.New("service.name resource is required")
		}
	}
	return out, nil
}
func (s *Ingest) Register(mux *http.ServeMux) {
	for _, signal := range []string{"logs", "metrics", "traces"} {
		mux.HandleFunc("POST /v1/"+signal, func(w http.ResponseWriter, r *http.Request) { s.receive(w, r, signal) })
	}
}
func (s *Ingest) receive(w http.ResponseWriter, r *http.Request, signal string) {
	key, e := s.Auth.ValidateKey(r)
	if e != nil {
		shared.Error(w, 401, "invalid write key")
		return
	}
	table := r.Header.Get("X-Lightmoni-Table")
	if !ValidTable(table) {
		s.Auth.RecordKey(key, "", "rejected", "invalid table")
		shared.Error(w, 400, "X-Lightmoni-Table requires a logical business name")
		return
	}
	if e := s.Auth.AuthorizeTable(key, table); e != nil {
		if errors.Is(e, auth.ErrTableNotAllowed) {
			s.Auth.RecordKey(key, "", "rejected", "table not allowed: "+table)
			shared.Error(w, 403, "Key 无权写入 table: "+table)
		} else {
			shared.Error(w, 503, "key permissions unavailable")
		}
		return
	}
	var reader io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, e := gzip.NewReader(r.Body)
		if e != nil {
			shared.Error(w, 400, "invalid gzip")
			return
		}
		defer gz.Close()
		reader = gz
	}
	raw, e := io.ReadAll(io.LimitReader(reader, (4<<20)+1))
	if e != nil || len(raw) > 4<<20 {
		shared.Error(w, 413, "batch exceeds 4 MiB")
		return
	}
	batchID := r.Header.Get("X-Lightmoni-Batch-ID")
	if batchID == "" {
		batchID = auth.ID()
	}
	if len(batchID) > 128 {
		shared.Error(w, 400, "invalid batch ID")
		return
	}
	if created := r.Header.Get("X-Lightmoni-Batch-Created-At"); created != "" {
		at, e := time.Parse(time.RFC3339Nano, created)
		if e != nil || at.After(time.Now().Add(5*time.Minute)) {
			shared.Error(w, 400, "invalid batch creation time")
			return
		}
		if time.Since(at) > 24*time.Hour {
			shared.Error(w, 400, "batch expired beyond 24-hour replay window")
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sum := sha256.Sum256(append([]byte(signal+"\x00"+table+"\x00"), raw...))
	digest := hex.EncodeToString(sum[:])
	received := time.Now().UTC().Format("2006-01-02 15:04:05.000000000")
	firstKey := key
	var oldDigest string
	var complete bool
	e = s.Catalog.DB.QueryRow("SELECT digest,first_received_at,key_id,completed FROM ingest_batches WHERE id=?", batchID).Scan(&oldDigest, &received, &firstKey, &complete)
	if e == nil && oldDigest != digest {
		s.Auth.RecordKey(key, "", "rejected", "batch ID content conflict")
		shared.Error(w, 400, "batch ID already has different content")
		return
	}
	if e == nil && complete {
		s.success(w, r, signal)
		return
	}
	rows, e := normalize(signal, raw, r.Header.Get("Content-Type"), received, firstKey)
	if e != nil {
		s.Auth.RecordKey(key, "", "rejected", e.Error())
		shared.Error(w, 400, e.Error())
		return
	}
	for _, n := range rows {
		if at, e := time.Parse("2006-01-02 15:04:05.000000000", fmt.Sprint(n.Row["event_time"])); e != nil || at.After(time.Now().Add(5*time.Minute)) || at.Before(time.Now().Add(-time.Duration(map[string]int{"log": 7, "metric": 30, "trace": 7}[n.Kind])*24*time.Hour)) {
			shared.Error(w, 400, "event falls outside retention or is ahead of server clock")
			return
		}
	}
	_, e = s.Catalog.DB.Exec("INSERT OR IGNORE INTO ingest_batches(id,digest,first_received_at,key_id) VALUES(?,?,?,?)", batchID, digest, received, firstKey)
	if e != nil {
		shared.Error(w, 503, "batch metadata store unavailable")
		return
	}
	grouped := map[string][]map[string]any{}
	service := ""
	resolved := map[string]string{}
	for i, n := range rows {
		service = fmt.Sprint(n.Row["service"])
		lookup := n.Kind + "\x00" + n.Subtype + "\x00" + service
		public, exists := resolved[lookup]
		var e error
		if !exists {
			public, e = s.Catalog.Ensure(r.Context(), n.Kind, table, n.Subtype, service)
			resolved[lookup] = public
		}
		if e != nil {
			s.Auth.RecordKey(key, service, "error", e.Error())
			shared.Error(w, 503, e.Error())
			return
		}
		id := sha256.Sum256([]byte(batchID + "\x00" + signal + "\x00" + strconv.Itoa(i)))
		n.Row["event_id"] = hex.EncodeToString(id[:])
		grouped["_lm_"+public] = append(grouped["_lm_"+public], n.Row)
	}
	for target, data := range grouped {
		if e = s.Catalog.CH.Insert(r.Context(), target, data); e != nil {
			s.Auth.RecordKey(key, service, "error", e.Error())
			shared.Error(w, 503, e.Error())
			return
		}
	}
	if _, e = s.Catalog.DB.Exec("UPDATE ingest_batches SET completed=1 WHERE id=?", batchID); e != nil {
		shared.Error(w, 503, "batch confirmation failed")
		return
	}
	_, _ = s.Catalog.DB.Exec("DELETE FROM ingest_batches WHERE first_received_at<?", time.Now().Add(-48*time.Hour).UTC().Format("2006-01-02 15:04:05.000000000"))
	s.Auth.RecordKey(key, service, "accepted", fmt.Sprintf("%d records", len(rows)))
	s.success(w, r, signal)
}
func (s *Ingest) success(w http.ResponseWriter, r *http.Request, signal string) {
	if strings.Contains(r.Header.Get("Content-Type"), "json") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	} else {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(200)
	}
}

func convertOTLPIDs(value any) error {
	switch x := value.(type) {
	case []any:
		for _, item := range x {
			if err := convertOTLPIDs(item); err != nil {
				return err
			}
		}
	case map[string]any:
		for k, v := range x {
			if k == "traceId" || k == "spanId" || k == "parentSpanId" {
				if text, ok := v.(string); ok && text != "" {
					raw, err := hex.DecodeString(text)
					if err != nil {
						return errors.New("OTLP JSON trace/span IDs must be hex")
					}
					expected := 8
					if k == "traceId" {
						expected = 16
					}
					if len(raw) != expected {
						return errors.New("invalid trace/span ID length")
					}
					x[k] = base64.StdEncoding.EncodeToString(raw)
				}
			} else if err := convertOTLPIDs(v); err != nil {
				return err
			}
		}
	}
	return nil
}
