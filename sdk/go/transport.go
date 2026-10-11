package moni

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	metriccollector "go.opentelemetry.io/proto/otlp/collector/metrics/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type DeliveryError struct {
	Retryable, Paused bool
	RetryAfter        time.Duration
	RejectedRecords   int
	Err               error
}

func (e *DeliveryError) Error() string {
	if e.Err == nil {
		return "telemetry delivery failed"
	}
	return e.Err.Error()
}
func (e *DeliveryError) Unwrap() error { return e.Err }

type HTTPExporter struct {
	Endpoint string
	Client   *http.Client
	mu       sync.RWMutex
	key      string
}

func NewHTTPExporter(endpoint, key string, client *http.Client) *HTTPExporter {
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &HTTPExporter{Endpoint: strings.TrimRight(endpoint, "/"), key: key, Client: client}
}
func (e *HTTPExporter) UpdateKey(key string) { e.mu.Lock(); e.key = key; e.mu.Unlock() }
func (c *Client) UpdateKey(key string) error {
	e, ok := c.s.cfg.Exporter.(interface{ UpdateKey(string) })
	if !ok {
		return errors.New("configured exporter does not support updating a Key")
	}
	e.UpdateKey(key)
	select {
	case c.s.retryNow <- struct{}{}:
	default:
	}
	return nil
}
func (e *HTTPExporter) Deliver(ctx context.Context, b FrozenBatch) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.Endpoint+"/v1/"+b.Signal, bytes.NewReader(b.Payload))
	if err != nil {
		return &DeliveryError{Err: err}
	}
	req.Header.Set("Content-Type", b.ContentType)
	req.Header.Set("X-Lightmoni-Table", b.Table)
	req.Header.Set("X-Lightmoni-Batch-ID", b.ID)
	req.Header.Set("X-Lightmoni-Batch-Created-At", b.CreatedAt)
	e.mu.RLock()
	key := e.key
	e.mu.RUnlock()
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := e.Client.Do(req)
	if err != nil {
		return &DeliveryError{Retryable: true, Err: errors.New("telemetry network request failed")}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, (64<<10)+1))
	if err != nil {
		return &DeliveryError{Retryable: true, Err: errors.New("telemetry response interrupted")}
	}
	if len(body) > 64<<10 {
		return &DeliveryError{Err: errors.New("telemetry response size exceeded")}
	}
	if resp.StatusCode != http.StatusOK {
		retry := resp.StatusCode == 429 || resp.StatusCode == 502 || resp.StatusCode == 503 || resp.StatusCode == 504
		paused := resp.StatusCode == 401 || resp.StatusCode == 403
		delay := parseRetryAfter(resp.Header.Get("Retry-After"))
		if paused && delay < 30*time.Second {
			delay = 30 * time.Second
		}
		return &DeliveryError{Retryable: retry || paused, Paused: paused, RetryAfter: delay, Err: fmt.Errorf("telemetry rejected with HTTP %d", resp.StatusCode)}
	}
	var message proto.Message
	switch b.Signal {
	case "logs":
		message = &logcollector.ExportLogsServiceResponse{}
	case "metrics":
		message = &metriccollector.ExportMetricsServiceResponse{}
	case "traces":
		message = &tracecollector.ExportTraceServiceResponse{}
	default:
		return &DeliveryError{Err: errors.New("unsupported signal")}
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		err = protojson.Unmarshal(body, message)
	} else {
		err = proto.Unmarshal(body, message)
	}
	if err != nil {
		return &DeliveryError{Retryable: true, Err: errors.New("invalid telemetry acknowledgment")}
	}
	rejected := 0
	switch m := message.(type) {
	case *logcollector.ExportLogsServiceResponse:
		if p := m.GetPartialSuccess(); p != nil {
			rejected = int(p.RejectedLogRecords)
		}
	case *metriccollector.ExportMetricsServiceResponse:
		if p := m.GetPartialSuccess(); p != nil {
			rejected = int(p.RejectedDataPoints)
		}
	case *tracecollector.ExportTraceServiceResponse:
		if p := m.GetPartialSuccess(); p != nil {
			rejected = int(p.RejectedSpans)
		}
	}
	if rejected > 0 {
		return &DeliveryError{RejectedRecords: rejected, Err: fmt.Errorf("OTLP partially accepted batch: %d rejected records (not retried)", rejected)}
	}
	return nil
}
func parseRetryAfter(value string) time.Duration {
	if n, err := strconv.Atoi(value); err == nil && n >= 0 {
		return time.Duration(n) * time.Second
	}
	if t, err := http.ParseTime(value); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}
