// Package telemetry is an application-owned wrapper around the LightMoni SDK.
// Business handlers only use this package, so SDK details stay in one place.
package telemetry

import (
	"context"
	"fmt"
	moni "github.com/workhold/lightmoni/sdk/go"
	"net/http"
	"sync/atomic"
	"time"
)

type Monitor struct {
	client   *moni.Client
	requests *moni.Counter
	duration *moni.Histogram
	active   *moni.Gauge
	inFlight atomic.Int64
}

func New(service, endpoint, key string) (*Monitor, error) {
	client, err := moni.New(moni.Config{Service: service, Table: "demo_http", Endpoint: endpoint, Key: key, Interval: 5 * time.Second})
	if err != nil {
		return nil, err
	}
	m := &Monitor{client: client}
	m.requests, err = client.Counter("http.requests", moni.MetricOptions{Unit: "{request}"})
	if err != nil {
		return nil, err
	}
	m.duration, err = client.Histogram("http.duration", moni.MetricOptions{Unit: "ms", Boundaries: []float64{5, 10, 25, 50, 100, 250, 1000}})
	if err != nil {
		return nil, err
	}
	m.active, err = client.Gauge("http.active", moni.MetricOptions{})
	return m, err
}

type response struct {
	http.ResponseWriter
	status int
}

func (w *response) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *response) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(body)
}
func (m *Monitor) HTTP(route string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		m.active.Record(r.Context(), float64(m.inFlight.Add(1)), nil)
		ctx, span := m.client.WithTable("demo_app").StartSpan(moni.ExtractHTTP(r.Context(), r.Header), r.Method+" "+route, moni.Attributes{"route": route})
		defer span.End()
		wrapped := &response{ResponseWriter: w}
		handler(wrapped, r.WithContext(ctx))
		status := wrapped.status
		if status == 0 {
			status = 200
		}
		if status >= 500 {
			span.SetError(fmt.Errorf("HTTP %d", status))
		}
		attrs := moni.Attributes{"route": route, "method": r.Method, "status": status}
		m.requests.Add(ctx, 1, attrs)
		m.duration.Record(ctx, float64(time.Since(start).Microseconds())/1000, attrs)
		m.active.Record(ctx, float64(m.inFlight.Add(-1)), nil)
	}
}
func (m *Monitor) Info(ctx context.Context, message string, fields map[string]any) {
	m.client.WithTable("demo_app").Log(ctx, "info", message, moni.Attributes(fields))
}
func (m *Monitor) Error(ctx context.Context, message string, fields map[string]any) {
	m.client.WithTable("demo_app").Log(ctx, "error", message, moni.Attributes(fields))
}
func (m *Monitor) Shutdown(ctx context.Context) error { return m.client.Shutdown(ctx) }
