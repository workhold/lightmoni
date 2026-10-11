package moni

import (
	"context"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

type TraceContext struct {
	TraceID, SpanID, TraceState string
	Flags                       byte
}
type traceContextKey struct{}

func TraceContextFromContext(ctx context.Context) (TraceContext, bool) {
	t, ok := ctx.Value(traceContextKey{}).(TraceContext)
	return t, ok && validHex(t.TraceID, 32) && validHex(t.SpanID, 16)
}
func ContextWithTrace(ctx context.Context, t TraceContext) context.Context {
	return context.WithValue(ctx, traceContextKey{}, t)
}
func validHex(s string, n int) bool {
	if len(s) != n || s == strings.Repeat("0", n) {
		return false
	}
	_, e := hex.DecodeString(s)
	return e == nil && s == strings.ToLower(s)
}
func ExtractHTTP(ctx context.Context, h http.Header) context.Context {
	p := strings.Split(h.Get("traceparent"), "-")
	if len(p) != 4 || p[0] != "00" || !validHex(p[1], 32) || !validHex(p[2], 16) || len(p[3]) != 2 {
		return ctx
	}
	flags, e := hex.DecodeString(p[3])
	if e != nil {
		return ctx
	}
	state := h.Get("tracestate")
	if len(state) > 512 {
		state = ""
	}
	return ContextWithTrace(ctx, TraceContext{TraceID: p[1], SpanID: p[2], TraceState: state, Flags: flags[0]})
}
func InjectHTTP(ctx context.Context, h http.Header) {
	t, ok := TraceContextFromContext(ctx)
	if !ok {
		return
	}
	h.Set("traceparent", "00-"+t.TraceID+"-"+t.SpanID+"-"+hex.EncodeToString([]byte{t.Flags}))
	if t.TraceState != "" {
		h.Set("tracestate", t.TraceState)
	}
}

func (c *Client) Log(ctx context.Context, level, body string, attrs Attributes) {
	s := c.s
	if c.table == "" {
		s.invalid("invalid table")
		return
	}
	if len(body) > 64<<10 {
		s.invalid("log body exceeded 64 KiB")
		return
	}
	attributes, _, err := encodeAttributes(attrs, s.cfg)
	if err != nil {
		s.invalid(err.Error())
		return
	}
	severity := logpb.SeverityNumber_SEVERITY_NUMBER_INFO
	switch strings.ToLower(level) {
	case "trace":
		severity = logpb.SeverityNumber_SEVERITY_NUMBER_TRACE
	case "debug":
		severity = logpb.SeverityNumber_SEVERITY_NUMBER_DEBUG
	case "warn", "warning":
		severity = logpb.SeverityNumber_SEVERITY_NUMBER_WARN
	case "error":
		severity = logpb.SeverityNumber_SEVERITY_NUMBER_ERROR
	case "fatal":
		severity = logpb.SeverityNumber_SEVERITY_NUMBER_FATAL
	}
	now := uint64(time.Now().UnixNano())
	record := &logpb.LogRecord{TimeUnixNano: now, ObservedTimeUnixNano: now, SeverityNumber: severity, SeverityText: strings.ToUpper(level), Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: body}}, Attributes: attributes}
	if t, ok := TraceContextFromContext(ctx); ok {
		record.TraceId, _ = hex.DecodeString(t.TraceID)
		record.SpanId, _ = hex.DecodeString(t.SpanID)
		record.Flags = uint32(t.Flags)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		s.stats.InvalidRecords++
		s.stats.LastError = "log after shutdown"
		return
	}
	// Source metadata is SDK-owned and is frozen with the record. Sequence gaps
	// are possible if a bounded buffer drops a log, and must remain visible.
	s.sourceSequence++
	filtered := record.Attributes[:0]
	for _, a := range record.Attributes {
		if a.Key != "lightmoni.source_id" && a.Key != "lightmoni.source_seq" {
			filtered = append(filtered, a)
		}
	}
	record.Attributes = append(filtered, kv("lightmoni.source_id", s.instance), &commonpb.KeyValue{Key: "lightmoni.source_seq", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: s.sourceSequence}}})
	cost := proto.Size(record) + 64
	if s.bufferBytes+cost > s.cfg.BufferBytes {
		s.dropBufferLocked()
		return
	}
	s.bufferBytes += cost
	s.logs[c.table] = append(s.logs[c.table], record)
}

type Span struct {
	mu      sync.Mutex
	client  *Client
	context TraceContext
	data    *tracepb.Span
	ended   bool
}

func (c *Client) Tracer() *Client { return c }
func (c *Client) Start(ctx context.Context, name string, attrs ...Attributes) (context.Context, *Span) {
	return c.StartSpan(ctx, name, attrs...)
}
func (c *Client) StartSpan(ctx context.Context, name string, attrs ...Attributes) (context.Context, *Span) {
	parent, hasParent := TraceContextFromContext(ctx)
	t := TraceContext{TraceID: newID(), SpanID: newID()[:16], Flags: 1}
	if hasParent {
		t.TraceID = parent.TraceID
		t.TraceState = parent.TraceState
		t.Flags = parent.Flags
	}
	traceID, _ := hex.DecodeString(t.TraceID)
	spanID, _ := hex.DecodeString(t.SpanID)
	data := &tracepb.Span{Name: name, TraceId: traceID, SpanId: spanID, TraceState: t.TraceState, Flags: uint32(t.Flags), Kind: tracepb.Span_SPAN_KIND_INTERNAL, StartTimeUnixNano: uint64(time.Now().UnixNano())}
	if hasParent {
		data.ParentSpanId, _ = hex.DecodeString(parent.SpanID)
	}
	if len(attrs) > 0 {
		a, _, err := encodeAttributes(attrs[0], c.s.cfg)
		if err == nil {
			data.Attributes = a
		} else {
			c.s.invalid(err.Error())
		}
	}
	span := &Span{client: c, context: t, data: data}
	return ContextWithTrace(ctx, t), span
}
func (s *Span) Context() TraceContext { return s.context }
func (s *Span) SetError(err error) {
	if err == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ended {
		message := err.Error()
		if len(message) > 4096 {
			message = message[:4096]
		}
		s.data.Status = &tracepb.Status{Code: tracepb.Status_STATUS_CODE_ERROR, Message: message}
	}
}
func (s *Span) SetKind(kind tracepb.Span_SpanKind) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ended {
		s.data.Kind = kind
	}
}
func (s *Span) End() {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	s.data.EndTimeUnixNano = uint64(time.Now().UnixNano())
	if s.data.EndTimeUnixNano < s.data.StartTimeUnixNano {
		s.data.EndTimeUnixNano = s.data.StartTimeUnixNano
	}
	data := s.data
	s.mu.Unlock()
	state := s.client.s
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.closing || s.client.table == "" {
		state.stats.InvalidRecords++
		state.stats.LastError = "span ended after shutdown or invalid table"
		return
	}
	if len(data.Name) == 0 || len(data.Name) > 255 {
		state.stats.InvalidRecords++
		state.stats.LastError = "invalid span name"
		return
	}
	cost := proto.Size(data) + 64
	if state.bufferBytes+cost > state.cfg.BufferBytes {
		state.dropBufferLocked()
		return
	}
	state.bufferBytes += cost
	state.spans[s.client.table] = append(state.spans[s.client.table], data)
}
func (s *state) dropBufferLocked() {
	s.stats.DroppedRecords++
	s.failure = errors.New("SDK record buffer capacity exceeded; telemetry lost")
	s.lastFailure = s.sequence
	s.stats.LastError = s.failure.Error()
}
