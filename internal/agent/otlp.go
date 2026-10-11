package agent

import (
	"compress/gzip"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	statuspb "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

var tableRE = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

type acceptError struct {
	status  int
	message string
}

func (e *acceptError) Error() string          { return e.message }
func reject(status int, message string) error { return &acceptError{status, message} }

func decodeRequest(signal, contentType string, body []byte) (proto.Message, []*resourcepb.Resource, error) {
	var msg proto.Message
	switch signal {
	case "logs":
		msg = &logcollector.ExportLogsServiceRequest{}
	case "metrics":
		msg = &metriccollector.ExportMetricsServiceRequest{}
	case "traces":
		msg = &tracecollector.ExportTraceServiceRequest{}
	default:
		return nil, nil, errors.New("unsupported signal")
	}
	var err error
	if contentType == "application/json" {
		err = decodeOTLPJSON(body, msg)
	} else if contentType == "application/x-protobuf" {
		err = proto.Unmarshal(body, msg)
	} else {
		return nil, nil, errors.New("unsupported Content-Type")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("invalid OTLP payload: %w", err)
	}
	var resources []*resourcepb.Resource
	switch r := msg.(type) {
	case *logcollector.ExportLogsServiceRequest:
		for _, v := range r.ResourceLogs {
			if v.Resource == nil {
				v.Resource = &resourcepb.Resource{}
			}
			resources = append(resources, v.Resource)
		}
	case *metriccollector.ExportMetricsServiceRequest:
		for _, v := range r.ResourceMetrics {
			if v.Resource == nil {
				v.Resource = &resourcepb.Resource{}
			}
			resources = append(resources, v.Resource)
		}
	case *tracecollector.ExportTraceServiceRequest:
		for _, v := range r.ResourceSpans {
			if v.Resource == nil {
				v.Resource = &resourcepb.Resource{}
			}
			resources = append(resources, v.Resource)
		}
	}
	if len(resources) == 0 {
		return nil, nil, errors.New("empty resource request")
	}
	return msg, resources, nil
}

// OTLP's JSON mapping overrides protobuf JSON for trace/span IDs: the wire
// uses hexadecimal IDs. protojson expects base64 bytes, so normalize just the
// defined identity fields before parsing and then freeze binary Protobuf.
func decodeOTLPJSON(body []byte, msg proto.Message) error {
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	var visit func(any) error
	visit = func(value any) error {
		switch node := value.(type) {
		case []any:
			for _, v := range node {
				if err := visit(v); err != nil {
					return err
				}
			}
		case map[string]any:
			for key, v := range node {
				size := 0
				switch key {
				case "traceId", "trace_id":
					size = 16
				case "spanId", "span_id", "parentSpanId", "parent_span_id":
					size = 8
				}
				if size > 0 {
					encoded, ok := v.(string)
					if !ok {
						return fmt.Errorf("%s must be a hex string", key)
					}
					if encoded != "" {
						raw, err := hex.DecodeString(encoded)
						if err != nil || len(raw) != size {
							return fmt.Errorf("%s must be %d hex characters", key, size*2)
						}
						node[key] = base64.StdEncoding.EncodeToString(raw)
					}
				} else if err := visit(v); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := visit(value); err != nil {
		return err
	}
	normalized, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return protojson.Unmarshal(normalized, msg)
}

func resourceString(r *resourcepb.Resource, key string) string {
	for _, a := range r.Attributes {
		if a.Key == key {
			return a.Value.GetStringValue()
		}
	}
	return ""
}
func resourceSet(r *resourcepb.Resource, key, value string) {
	v := &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}
	found := false
	for _, a := range r.Attributes {
		if a.Key == key {
			a.Value = v
			found = true
		}
	}
	if found {
		return
	}
	r.Attributes = append(r.Attributes, &commonpb.KeyValue{Key: key, Value: v})
}

// Deliver is the SDK's in-process exporter. Returning nil means SQLite committed
// both queue data and receipt with synchronous=FULL.
func (a *Agent) Deliver(ctx context.Context, b moni.FrozenBatch) error {
	created, err := time.Parse(time.RFC3339Nano, b.CreatedAt)
	if err != nil {
		return &moni.DeliveryError{Retryable: false, Err: err}
	}
	err = a.Accept(ctx, Batch{ID: b.ID, Signal: b.Signal, Table: b.Table, Service: b.Service, CreatedAt: created, Payload: b.Payload, ContentType: b.ContentType}, true)
	if err == nil {
		return nil
	}
	var ae *acceptError
	if errors.As(err, &ae) {
		return &moni.DeliveryError{Retryable: ae.status == 429 || ae.status == 503, Err: err}
	}
	return &moni.DeliveryError{Retryable: true, Err: err}
}

func (a *Agent) Accept(ctx context.Context, b Batch, owned bool) error {
	return a.accept(ctx, b, owned, nil)
}

func (a *Agent) accept(ctx context.Context, b Batch, owned bool, cursor *logCursor) error {
	if !tableRE.MatchString(b.Table) || strings.HasPrefix(b.Table, "log_") || strings.HasPrefix(b.Table, "metric_") || strings.HasPrefix(b.Table, "trace_") {
		return reject(400, "table must be a logical name matching [a-z][a-z0-9_]{0,47}, without signal prefix")
	}
	if int64(len(b.Payload)) > a.cfg.MaxBatchBytes {
		return reject(413, "batch exceeds configured byte limit")
	}
	if _, err := uuid.Parse(b.ID); err != nil {
		return reject(400, "invalid batch ID")
	}
	if b.CreatedAt.IsZero() || time.Since(b.CreatedAt) > a.cfg.maxAge() {
		return reject(400, "expired: batch exceeds max_age_seconds")
	}
	if b.CreatedAt.After(time.Now().Add(5 * time.Minute)) {
		return reject(400, "batch created_at is too far in the future")
	}
	msg, resources, err := decodeRequest(b.Signal, b.ContentType, b.Payload)
	if err != nil {
		return reject(400, err.Error())
	}
	services := map[string]bool{}
	for _, r := range resources {
		service := resourceString(r, "service.name")
		if service == "" || len(service) > 128 {
			return reject(400, "service.name is required and at most 128 bytes")
		}
		services[service] = true
	}
	if owned && len(services) != 1 {
		return reject(400, "stable LightMoni batches must contain one service; split exports by service")
	}
	var names []string
	for name := range services {
		names = append(names, name)
	}
	sort.Strings(names)
	if b.Service != "" && !services[b.Service] {
		return reject(400, "batch service differs from OTLP resource")
	}
	b.Service = names[0]
	canonicalInput, err := proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if err != nil {
		return err
	}
	inputHash := digest([]byte(b.Signal + "\x00" + b.Table + "\x00" + b.CreatedAt.UTC().Format(time.RFC3339Nano) + "\x00" + string(canonicalInput)))
	receipt, exists, err := a.queue.Receipt(ctx, b.ID)
	if err != nil {
		return err
	}
	identity, received := a.identity, time.Now().UTC()
	if exists {
		if receipt.InputHash != inputHash {
			return reject(409, ErrConflict.Error())
		}
		identity, received = receipt.Identity, receipt.ReceivedAt
	}
	for _, r := range resources {
		resourceSet(r, "host.id", identity.HostID)
		resourceSet(r, "lightmoni.agent_id", identity.AgentID)
	}
	// Canonical deterministic Protobuf means re-enrichment reproduces the exact
	// forwarding bytes even when the original incoming representation was JSON.
	b.Payload, err = proto.MarshalOptions{Deterministic: true}.Marshal(msg)
	if err != nil {
		return err
	}
	b.ContentType = "application/x-protobuf"
	if int64(len(b.Payload)) > a.cfg.MaxBatchBytes {
		return reject(413, "enriched batch exceeds limit; lower SDK max_batch_bytes")
	}
	err = a.queue.enqueue(ctx, b, inputHash, identity, received, cursor)
	if errors.Is(err, ErrCapacity) {
		return reject(503, err.Error())
	}
	if errors.Is(err, ErrConflict) {
		return reject(409, err.Error())
	}
	return err
}

func emptyResponse(signal string) proto.Message {
	switch signal {
	case "logs":
		return &logcollector.ExportLogsServiceResponse{}
	case "metrics":
		return &metriccollector.ExportMetricsServiceResponse{}
	default:
		return &tracecollector.ExportTraceServiceResponse{}
	}
}
func jsonProto(body []byte, msg proto.Message) error   { return protojson.Unmarshal(body, msg) }
func binaryProto(body []byte, msg proto.Message) error { return proto.Unmarshal(body, msg) }
func hasPartial(msg proto.Message) bool {
	switch m := msg.(type) {
	case *logcollector.ExportLogsServiceResponse:
		return m.PartialSuccess != nil
	case *metriccollector.ExportMetricsServiceResponse:
		return m.PartialSuccess != nil
	case *tracecollector.ExportTraceServiceResponse:
		return m.PartialSuccess != nil
	}
	return false
}
func writeProto(w http.ResponseWriter, status int, contentType string, msg proto.Message) {
	var data []byte
	if contentType == "application/json" {
		data, _ = protojson.Marshal(msg)
	} else {
		contentType = "application/x-protobuf"
		data, _ = proto.Marshal(msg)
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (a *Agent) receiver(signal string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		contentType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil {
			contentType = "application/x-protobuf"
		}
		fail := func(code int, message string) {
			if code == 503 || code == 429 {
				w.Header().Set("Retry-After", "2")
			}
			writeProto(w, code, contentType, &statuspb.Status{Message: message})
		}
		if a.cfg.LocalToken != "" {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.LocalToken)) != 1 {
				fail(401, "local receiver token required")
				return
			}
		}
		var reader io.Reader = http.MaxBytesReader(w, r.Body, a.cfg.MaxBatchBytes)
		if encoding := r.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
			if encoding != "gzip" {
				fail(415, "unsupported Content-Encoding")
				return
			}
			gz, e := gzip.NewReader(reader)
			if e != nil {
				fail(400, "invalid gzip payload")
				return
			}
			defer gz.Close()
			reader = gz
		}
		body, err := io.ReadAll(io.LimitReader(reader, a.cfg.MaxBatchBytes+1))
		if err != nil {
			fail(413, "body unreadable or too large")
			return
		}
		if int64(len(body)) > a.cfg.MaxBatchBytes {
			fail(413, "decompressed batch too large")
			return
		}
		id := r.Header.Get("X-Lightmoni-Batch-ID")
		owned := id != ""
		created := time.Now().UTC()
		if owned {
			created, err = time.Parse(time.RFC3339Nano, r.Header.Get("X-Lightmoni-Batch-Created-At"))
			if err != nil {
				fail(400, "valid X-Lightmoni-Batch-Created-At required")
				return
			}
		} else {
			id = uuid.NewString()
		}
		err = a.Accept(r.Context(), Batch{ID: id, Signal: signal, Table: r.Header.Get("X-Lightmoni-Table"), CreatedAt: created, Payload: body, ContentType: contentType}, owned)
		if err != nil {
			var ae *acceptError
			if errors.As(err, &ae) {
				fail(ae.status, ae.message)
			} else {
				a.setError("durable receive: " + err.Error())
				fail(503, "durable queue unavailable")
			}
			return
		}
		writeProto(w, 200, contentType, emptyResponse(signal))
	}
}
