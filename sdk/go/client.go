// Package moni provides bounded, asynchronous telemetry for LightMoni.
// Records remain in memory until the configured exporter durably accepts them.
package moni

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	mathrand "math/rand"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

type Attributes map[string]any

// Config has no required private Key when using the local Agent.
type Config struct {
	Service, Table, Endpoint, Key                                      string
	InstanceID                                                         string
	Resource                                                           Attributes
	Exporter                                                           Exporter
	Interval, RequestTimeout, RetryMin, RetryMax                       time.Duration
	QueueBytes, QueueBatches, BufferBytes, MaxBatchBytes               int
	CardinalityLimit, MaxInstruments, MaxAttributes, MaxAttributeBytes int
}

// FrozenBatch is immutable after delivery begins. An exporter retaining it must
// take ownership of a Clone, and return nil only after its durable commit.
type FrozenBatch struct {
	Signal      string `json:"signal"`
	Table       string `json:"table"`
	Service     string `json:"service"`
	ID          string `json:"id"`
	CreatedAt   string `json:"created_at"`
	ContentType string `json:"content_type"`
	Payload     []byte `json:"payload"`
}

func (b FrozenBatch) Clone() FrozenBatch { b.Payload = append([]byte(nil), b.Payload...); return b }

// Exporter may write HTTP or commit directly to an Agent's durable queue.
type Exporter interface {
	Deliver(context.Context, FrozenBatch) error
}
type ExporterFunc func(context.Context, FrozenBatch) error

func (f ExporterFunc) Deliver(ctx context.Context, b FrozenBatch) error { return f(ctx, b) }

type Stats struct {
	PendingBatches, PendingBytes, BufferBytes                                                          int
	DeliveredBatches, RetriedBatches, DroppedRecords, RejectedRecords, InvalidRecords, OverflowRecords uint64
	LastError                                                                                          string
}

type queuedBatch struct {
	batch    FrozenBatch
	sequence uint64
	records  int
}
type state struct {
	mu             sync.Mutex
	cfg            Config
	resource       *resourcepb.Resource
	instance       string
	metrics        map[string]*instrument
	logs           map[string][]*logpb.LogRecord
	spans          map[string][]*tracepb.Span
	queue          []queuedBatch
	sequence       uint64
	sourceSequence int64
	lastFailure    uint64
	failure        error
	bufferBytes    int
	stats          Stats
	changed        chan struct{}
	wake           chan struct{}
	retryNow       chan struct{}
	ctx            context.Context
	cancel         context.CancelFunc
	done           chan struct{}
	closing        bool
	closed         bool
}

type Client struct {
	s     *state
	table string
}

var tablePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

func validTable(table string) bool {
	return tablePattern.MatchString(table) && !strings.HasPrefix(table, "log_") && !strings.HasPrefix(table, "metric_") && !strings.HasPrefix(table, "trace_")
}

func New(cfg Config) (*Client, error) {
	if cfg.Service == "" || len(cfg.Service) > 128 {
		return nil, errors.New("service is required and must be at most 128 bytes")
	}
	if !validTable(cfg.Table) {
		return nil, errors.New("table must match [a-z][a-z0-9_]{0,47} without a reserved type prefix")
	}
	if cfg.Exporter == nil {
		u, err := url.Parse(cfg.Endpoint)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, errors.New("endpoint must be an absolute http(s) URL, or provide an Exporter")
		}
	}
	if cfg.Interval == 0 {
		cfg.Interval = 10 * time.Second
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = 10 * time.Second
	}
	if cfg.RetryMin == 0 {
		cfg.RetryMin = 200 * time.Millisecond
	}
	if cfg.RetryMax == 0 {
		cfg.RetryMax = 30 * time.Second
	}
	if cfg.QueueBytes == 0 {
		cfg.QueueBytes = 8 << 20
	}
	if cfg.QueueBatches == 0 {
		cfg.QueueBatches = 256
	}
	if cfg.BufferBytes == 0 {
		cfg.BufferBytes = 8 << 20
	}
	if cfg.MaxBatchBytes == 0 {
		cfg.MaxBatchBytes = 1 << 20
	}
	if cfg.CardinalityLimit == 0 {
		cfg.CardinalityLimit = 2000
	}
	if cfg.MaxInstruments == 0 {
		cfg.MaxInstruments = 256
	}
	if cfg.MaxAttributes == 0 {
		cfg.MaxAttributes = 32
	}
	if cfg.MaxAttributeBytes == 0 {
		cfg.MaxAttributeBytes = 4096
	}
	if cfg.Interval < 0 || cfg.RequestTimeout <= 0 || cfg.RetryMin <= 0 || cfg.RetryMax < cfg.RetryMin || cfg.QueueBytes <= 0 || cfg.QueueBatches <= 0 || cfg.BufferBytes <= 0 || cfg.MaxBatchBytes <= 0 || cfg.CardinalityLimit <= 0 || cfg.MaxInstruments <= 0 || cfg.MaxAttributes <= 0 || cfg.MaxAttributeBytes <= 0 {
		return nil, errors.New("buffer limits and timeouts must be positive")
	}
	if cfg.MaxBatchBytes > cfg.QueueBytes {
		return nil, errors.New("max batch bytes cannot exceed queue bytes")
	}
	instance := cfg.InstanceID
	if instance == "" {
		instance = newID()
	}
	attrs, _, err := encodeAttributes(cfg.Resource, cfg)
	if err != nil {
		return nil, fmt.Errorf("resource: %w", err)
	}
	for _, a := range attrs {
		if a.Key == "service.name" || a.Key == "service.instance.id" {
			return nil, errors.New("service identity must be configured separately from Resource")
		}
	}
	attrs = append(attrs, kv("service.name", cfg.Service), kv("service.instance.id", instance))
	ctx, cancel := context.WithCancel(context.Background())
	s := &state{cfg: cfg, resource: &resourcepb.Resource{Attributes: attrs}, instance: instance,
		metrics: map[string]*instrument{}, logs: map[string][]*logpb.LogRecord{}, spans: map[string][]*tracepb.Span{},
		changed: make(chan struct{}), wake: make(chan struct{}, 1), retryNow: make(chan struct{}, 1), ctx: ctx, cancel: cancel, done: make(chan struct{})}
	if cfg.Exporter == nil {
		s.cfg.Exporter = NewHTTPExporter(cfg.Endpoint, cfg.Key, nil)
	}
	c := &Client{s: s, table: cfg.Table}
	go s.run()
	return c, nil
}

func (c *Client) WithTable(table string) *Client {
	if !validTable(table) {
		c.s.invalid("invalid table")
		return &Client{s: c.s, table: ""}
	}
	return &Client{s: c.s, table: table}
}
func (c *Client) Stats() Stats {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	out := c.s.stats
	out.BufferBytes = c.s.bufferBytes
	return out
}
func (c *Client) InstanceID() string { return c.s.instance }

func (s *state) notifyLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
	select {
	case s.wake <- struct{}{}:
	default:
	}
}
func (s *state) invalid(msg string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.InvalidRecords++
	s.stats.LastError = msg
}

// Flush freezes the current window, then waits only for batches up to that
// boundary. An earlier permanent rejection or queue loss is reported as error.
func (c *Client) Flush(ctx context.Context) error {
	s := c.s
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return errors.New("SDK is closed")
	}
	s.collectLocked(time.Now())
	target := s.sequence
	s.notifyLocked()
	s.mu.Unlock()
	return s.wait(ctx, target)
}
func (s *state) wait(ctx context.Context, target uint64) error {
	for {
		s.mu.Lock()
		pending := len(s.queue) > 0 && s.queue[0].sequence <= target
		failure := s.failure
		failureSeq := s.lastFailure
		changed := s.changed
		s.mu.Unlock()
		if !pending {
			if failure != nil && failureSeq <= target {
				return failure
			}
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("flush incomplete: %w", ctx.Err())
		case <-changed:
		case <-s.ctx.Done():
			return errors.New("SDK stopped before durable acknowledgment")
		}
	}
}
func (c *Client) Shutdown(ctx context.Context) error {
	s := c.s
	s.mu.Lock()
	if s.closed {
		err := s.failure
		s.mu.Unlock()
		return err
	}
	s.closing = true
	s.collectLocked(time.Now())
	target := s.sequence
	s.notifyLocked()
	s.mu.Unlock()
	err := s.wait(ctx, target)
	s.cancel()
	<-s.done
	s.mu.Lock()
	s.closed = true
	s.notifyLocked()
	s.mu.Unlock()
	return err
}

func (s *state) run() {
	defer close(s.done)
	ticker := time.NewTicker(s.cfg.Interval)
	defer ticker.Stop()
	// Collection runs independently of a blocked network request or backoff.
	collectorDone := make(chan struct{})
	go func() {
		defer close(collectorDone)
		for {
			select {
			case <-ticker.C:
				s.mu.Lock()
				if !s.closing {
					s.collectLocked(time.Now())
					s.notifyLocked()
				}
				s.mu.Unlock()
			case <-s.ctx.Done():
				return
			}
		}
	}()
	defer func() { <-collectorDone }()
	backoff := s.cfg.RetryMin
	for {
		s.mu.Lock()
		if len(s.queue) == 0 {
			s.mu.Unlock()
			select {
			case <-s.ctx.Done():
				return
			case <-s.wake:
			}
			continue
		}
		item := s.queue[0]
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(s.ctx, s.cfg.RequestTimeout)
		err := s.cfg.Exporter.Deliver(ctx, item.batch.Clone())
		cancel()
		if s.ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		if err == nil {
			s.queue = s.queue[1:]
			s.stats.PendingBatches--
			s.stats.PendingBytes -= len(item.batch.Payload)
			s.stats.DeliveredBatches++
			s.notifyLocked()
			s.mu.Unlock()
			backoff = s.cfg.RetryMin
			continue
		}
		s.stats.LastError = err.Error()
		var de *DeliveryError
		if errors.As(err, &de) && !de.Retryable {
			s.queue = s.queue[1:]
			s.stats.PendingBatches--
			s.stats.PendingBytes -= len(item.batch.Payload)
			rejected := item.records
			if de.RejectedRecords > 0 {
				rejected = de.RejectedRecords
			}
			s.stats.RejectedRecords += uint64(rejected)
			s.failure = err
			s.lastFailure = item.sequence
			s.notifyLocked()
			s.mu.Unlock()
			backoff = s.cfg.RetryMin
			continue
		}
		s.stats.RetriedBatches++
		s.mu.Unlock()
		delay := backoff/2 + time.Duration(mathrand.Int63n(int64(backoff/2)+1))
		if de != nil && de.RetryAfter > delay {
			delay = de.RetryAfter
		}
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-s.retryNow:
			timer.Stop()
		case <-s.ctx.Done():
			timer.Stop()
			return
		}
		if backoff < s.cfg.RetryMax/2 {
			backoff *= 2
		} else {
			backoff = s.cfg.RetryMax
		}
	}
}

func (s *state) enqueueLocked(signal, table string, message proto.Message, records int, now time.Time) {
	if records == 0 {
		return
	}
	payload, err := proto.MarshalOptions{Deterministic: true}.Marshal(message)
	s.sequence++
	if err != nil || len(payload) > s.cfg.MaxBatchBytes || len(s.queue) >= s.cfg.QueueBatches || s.stats.PendingBytes+len(payload) > s.cfg.QueueBytes {
		s.stats.DroppedRecords += uint64(records)
		s.lastFailure = s.sequence
		s.failure = errors.New("SDK queue or batch capacity exceeded; telemetry lost")
		s.stats.LastError = s.failure.Error()
		return
	}
	id := newID()
	id = id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]
	b := FrozenBatch{Signal: signal, Table: table, Service: s.cfg.Service, ID: id, CreatedAt: now.UTC().Format(time.RFC3339Nano), ContentType: "application/x-protobuf", Payload: payload}
	s.queue = append(s.queue, queuedBatch{batch: b, sequence: s.sequence, records: records})
	s.stats.PendingBatches++
	s.stats.PendingBytes += len(payload)
}

func (s *state) collectLocked(now time.Time) {
	// Split by metric point to keep even high-cardinality exports bounded while
	// retaining one Metric per name within each OTLP request.
	tables := map[string]bool{}
	for _, m := range s.metrics {
		tables[m.table] = true
	}
	for t := range s.logs {
		tables[t] = true
	}
	for t := range s.spans {
		tables[t] = true
	}
	keys := make([]string, 0, len(tables))
	for t := range tables {
		keys = append(keys, t)
	}
	sort.Strings(keys)
	for _, table := range keys {
		var metrics []*metricpb.Metric
		for _, m := range s.metrics {
			if m.table == table {
				metrics = append(metrics, m.collect(now)...)
			}
		}
		sort.SliceStable(metrics, func(i, j int) bool { return metrics[i].Name < metrics[j].Name })
		request := func(ms []*metricpb.Metric) *metriccollector.ExportMetricsServiceRequest {
			return &metriccollector.ExportMetricsServiceRequest{ResourceMetrics: []*metricpb.ResourceMetrics{{Resource: s.resource, ScopeMetrics: []*metricpb.ScopeMetrics{{Scope: &commonpb.InstrumentationScope{Name: "lightmoni/sdk/go"}, Metrics: mergeMetrics(ms)}}}}}
		}
		var group []*metricpb.Metric
		count := 0
		// A one-point Metric includes more metadata than its merged form. Summing
		// those sizes is a conservative bound without repeatedly encoding the
		// whole growing request (quadratic in the number of dimensions).
		baseSize := proto.Size(request(nil)) + 64
		groupSize := baseSize
		for _, m := range metrics {
			cost := proto.Size(m) + 10
			if len(group) > 0 && groupSize+cost > s.cfg.MaxBatchBytes {
				s.enqueueLocked("metrics", table, request(group), count, now)
				group = nil
				count = 0
				groupSize = baseSize
			}
			group = append(group, m)
			count++
			groupSize += cost
		}
		if len(group) > 0 {
			s.enqueueLocked("metrics", table, request(group), count, now)
		}
		logs := s.logs[table]
		logreq := func(rs []*logpb.LogRecord) *logcollector.ExportLogsServiceRequest {
			return &logcollector.ExportLogsServiceRequest{ResourceLogs: []*logpb.ResourceLogs{{Resource: s.resource, ScopeLogs: []*logpb.ScopeLogs{{Scope: &commonpb.InstrumentationScope{Name: "lightmoni/sdk/go"}, LogRecords: rs}}}}}
		}
		start := 0
		groupSize = proto.Size(logreq(nil)) + 64
		for i := range logs {
			cost := proto.Size(logs[i]) + 10
			if i > start && groupSize+cost > s.cfg.MaxBatchBytes {
				s.enqueueLocked("logs", table, logreq(logs[start:i]), i-start, now)
				start = i
				groupSize = proto.Size(logreq(nil)) + 64
			}
			groupSize += cost
		}
		if start < len(logs) {
			s.enqueueLocked("logs", table, logreq(logs[start:]), len(logs)-start, now)
		}
		spans := s.spans[table]
		tracereq := func(rs []*tracepb.Span) *tracecollector.ExportTraceServiceRequest {
			return &tracecollector.ExportTraceServiceRequest{ResourceSpans: []*tracepb.ResourceSpans{{Resource: s.resource, ScopeSpans: []*tracepb.ScopeSpans{{Scope: &commonpb.InstrumentationScope{Name: "lightmoni/sdk/go"}, Spans: rs}}}}}
		}
		start = 0
		groupSize = proto.Size(tracereq(nil)) + 64
		for i := range spans {
			cost := proto.Size(spans[i]) + 10
			if i > start && groupSize+cost > s.cfg.MaxBatchBytes {
				s.enqueueLocked("traces", table, tracereq(spans[start:i]), i-start, now)
				start = i
				groupSize = proto.Size(tracereq(nil)) + 64
			}
			groupSize += cost
		}
		if start < len(spans) {
			s.enqueueLocked("traces", table, tracereq(spans[start:]), len(spans)-start, now)
		}
	}
	s.logs = map[string][]*logpb.LogRecord{}
	s.spans = map[string][]*tracepb.Span{}
	s.bufferBytes = 0
}

func encodeAttributes(attrs Attributes, cfg Config) ([]*commonpb.KeyValue, string, error) {
	if len(attrs) > cfg.MaxAttributes {
		return nil, "", errors.New("attribute count exceeded")
	}
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	result := make([]*commonpb.KeyValue, 0, len(keys))
	total := 0
	for _, k := range keys {
		if len(k) == 0 || len(k) > 128 {
			return nil, "", errors.New("invalid attribute key")
		}
		var v *commonpb.AnyValue
		switch n := attrs[k].(type) {
		case string:
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: n}}
		case bool:
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: n}}
		case int:
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: int64(n)}}
		case int32:
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: int64(n)}}
		case int64:
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: n}}
		case float32:
			f := float64(n)
			if math.IsNaN(f) || math.IsInf(f, 0) {
				return nil, "", errors.New("nonfinite attribute")
			}
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: f}}
		case float64:
			if math.IsNaN(n) || math.IsInf(n, 0) {
				return nil, "", errors.New("nonfinite attribute")
			}
			v = &commonpb.AnyValue{Value: &commonpb.AnyValue_DoubleValue{DoubleValue: n}}
		default:
			return nil, "", fmt.Errorf("unsupported attribute type for %q", k)
		}
		item := &commonpb.KeyValue{Key: k, Value: v}
		total += proto.Size(item)
		result = append(result, item)
	}
	if total > cfg.MaxAttributeBytes {
		return nil, "", errors.New("attribute bytes exceeded")
	}
	// Deterministic Protobuf preserves both value types and sorted key order.
	encoded, _ := proto.MarshalOptions{Deterministic: true}.Marshal(&resourcepb.Resource{Attributes: result})
	return result, string(encoded), nil
}

func kv(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}}
}
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto randomness unavailable")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return hex.EncodeToString(b)
}
