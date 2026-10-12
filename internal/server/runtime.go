package server

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

type RuntimeMonitor struct {
	Client                                        *moni.Client
	requests, records, bytes                      *moni.Counter
	duration                                      *moni.Histogram
	heartbeat, heap, goroutines, pending, dropped *moni.Gauge
}

func (s *Server) initRuntime(ctx context.Context) error {
	for table, kinds := range map[string][]string{"lightmoni_center": {"metric:sum", "metric:gauge", "metric:histogram", "log:"}, "lightmoni_agent": {"metric:gauge", "log:"}, "lightmoni_sdk": {"metric:gauge", "log:"}} {
		for _, entry := range kinds {
			parts := strings.Split(entry, ":")
			if _, err := s.Catalog.Ensure(ctx, parts[0], table, parts[1], map[string]string{"lightmoni_center": "lightmoni-center", "lightmoni_agent": "lightmoni-agent", "lightmoni_sdk": ""}[table]); err != nil {
				return err
			}
		}
	}
	hostname, _ := os.Hostname()
	client, err := moni.New(moni.Config{Service: "lightmoni-center", Table: "lightmoni_center", Exporter: s.Catalog.InternalExporter(), DisableSelfTelemetry: true, Interval: 10 * time.Second, Resource: moni.Attributes{"host.name": hostname}})
	if err != nil {
		return err
	}
	m := &RuntimeMonitor{Client: client}
	m.requests, err = client.Counter("lightmoni.center.ingest_requests", moni.MetricOptions{Unit: "{request}"})
	if err != nil {
		return err
	}
	m.records, err = client.Counter("lightmoni.center.received_records", moni.MetricOptions{Unit: "{record}"})
	if err != nil {
		return err
	}
	m.bytes, err = client.Counter("lightmoni.center.received_bytes", moni.MetricOptions{Unit: "By"})
	if err != nil {
		return err
	}
	m.duration, err = client.Histogram("lightmoni.center.ingest_duration", moni.MetricOptions{Unit: "ms"})
	if err != nil {
		return err
	}
	gauges := []struct {
		name   string
		target **moni.Gauge
	}{{"heartbeat", &m.heartbeat}, {"heap_bytes", &m.heap}, {"goroutines", &m.goroutines}, {"pending_batches", &m.pending}, {"dropped_records", &m.dropped}}
	for _, item := range gauges {
		*item.target, err = client.Gauge("lightmoni.center."+item.name, moni.MetricOptions{})
		if err != nil {
			return err
		}
	}
	s.Runtime = m
	return nil
}
func (m *RuntimeMonitor) accepted(signal string, records, bytes int) {
	m.records.Add(context.Background(), int64(records), moni.Attributes{"signal": signal})
	m.bytes.Add(context.Background(), int64(bytes), moni.Attributes{"signal": signal})
}

type runtimeResponse struct {
	http.ResponseWriter
	status int
}

func (w *runtimeResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *runtimeResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(body)
}
func (w *runtimeResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *runtimeResponse) Flush() {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}
func (m *RuntimeMonitor) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		signal := strings.TrimPrefix(r.URL.Path, "/v1/")
		if r.Method != "POST" || (signal != "logs" && signal != "metrics" && signal != "traces") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		response := &runtimeResponse{ResponseWriter: w}
		next.ServeHTTP(response, r)
		status := response.status
		if status == 0 {
			status = 200
		}
		attrs := moni.Attributes{"signal": signal, "status": status}
		m.requests.Add(r.Context(), 1, attrs)
		m.duration.Record(r.Context(), float64(time.Since(start).Microseconds())/1000, attrs)
	})
}
func (s *Server) RunRuntime(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		stats := s.Runtime.Client.Stats()
		s.Runtime.heartbeat.Record(ctx, 1, nil)
		s.Runtime.heap.Record(ctx, float64(mem.HeapAlloc), nil)
		s.Runtime.goroutines.Record(ctx, float64(runtime.NumGoroutine()), nil)
		s.Runtime.pending.Record(ctx, float64(stats.PendingBatches), nil)
		s.Runtime.dropped.Record(ctx, float64(stats.DroppedRecords), nil)
		select {
		case <-ctx.Done():
			stop, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = s.Runtime.Client.Shutdown(stop)
			cancel()
			return
		case <-ticker.C:
		}
	}
}

// RuntimeLogHandler forwards bounded runtime messages without HTTP or logging
// from the exporter itself. Exporter failures remain visible in queue metrics.
type RuntimeLogHandler struct {
	Console slog.Handler
	Monitor *RuntimeMonitor
	Secrets []string
}

func (h *RuntimeLogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.Console.Enabled(ctx, level)
}
func (h *RuntimeLogHandler) Handle(ctx context.Context, record slog.Record) error {
	attrs := moni.Attributes{"lightmoni.component": "center"}
	body := record.Message
	for _, secret := range h.Secrets {
		if secret != "" {
			body = strings.ReplaceAll(body, secret, "[redacted]")
		}
	}
	if len(body) > 4096 {
		body = body[:4096]
	}
	// Attribute values can contain arbitrary network errors/URLs. Forward their
	// names only; normal local console logs retain the full diagnostic context.
	record.Attrs(func(a slog.Attr) bool { attrs["field."+a.Key] = true; return len(attrs) < 16 })
	h.Monitor.Client.Log(ctx, strings.ToLower(record.Level.String()), body, attrs)
	return h.Console.Handle(ctx, record)
}
func (h *RuntimeLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	copy := *h
	copy.Console = h.Console.WithAttrs(attrs)
	return &copy
}
func (h *RuntimeLogHandler) WithGroup(name string) slog.Handler {
	copy := *h
	copy.Console = h.Console.WithGroup(name)
	return &copy
}
