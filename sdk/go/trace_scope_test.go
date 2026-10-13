package moni

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	tracecollector "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func traceRecords(t *testing.T, batches []FrozenBatch) (map[string]*logpb.LogRecord, map[string]*tracepb.Span) {
	t.Helper()
	logs, spans := map[string]*logpb.LogRecord{}, map[string]*tracepb.Span{}
	for _, batch := range batches {
		switch batch.Signal {
		case "logs":
			var request logcollector.ExportLogsServiceRequest
			if err := proto.Unmarshal(batch.Payload, &request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceLogs {
				for _, scope := range resource.ScopeLogs {
					for _, log := range scope.LogRecords {
						logs[log.Body.GetStringValue()] = log
					}
				}
			}
		case "traces":
			var request tracecollector.ExportTraceServiceRequest
			if err := proto.Unmarshal(batch.Payload, &request); err != nil {
				t.Fatal(err)
			}
			for _, resource := range request.ResourceSpans {
				for _, scope := range resource.ScopeSpans {
					for _, span := range scope.Spans {
						spans[hex.EncodeToString(span.SpanId)] = span
					}
				}
			}
		}
	}
	return logs, spans
}

func TestTraceHandlerAndTransportAcrossConcurrentServices(t *testing.T) {
	upSink, downSink := &recorder{}, &recorder{}
	makeClient := func(service string, sink *recorder) *Client {
		client, err := New(Config{Service: service, Table: "http", Exporter: sink, Interval: time.Hour, DisableSelfTelemetry: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = client.Shutdown(ctx)
		})
		return client
	}
	up, down := makeClient("upstream", upSink), makeClient("downstream", downSink)
	downServer := httptest.NewServer(down.TraceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace, _ := TraceContextFromContext(r.Context())
		down.Logger(r.Context()).WithTable("app").Log("info", "down:"+r.URL.Query().Get("id"), nil)
		_ = json.NewEncoder(w).Encode(trace)
	})))
	defer downServer.Close()
	httpClient := &http.Client{Transport: TraceTransport{}, Timeout: 5 * time.Second}
	upServer := httptest.NewServer(up.TraceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		logger := up.Logger(r.Context()).WithTable("app")
		logger.Log("info", "up:"+id, nil)
		request, err := http.NewRequestWithContext(r.Context(), "GET", downServer.URL+"?id="+id, nil)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		request.Header.Set("traceparent", "00-ffffffffffffffffffffffffffffffff-eeeeeeeeeeeeeeee-01")
		request.Header.Set("tracestate", "stale=value")
		response, err := httpClient.Do(request)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer response.Body.Close()
		var downstream TraceContext
		if err = json.NewDecoder(response.Body).Decode(&downstream); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		// The transport must leave the caller's original headers intact.
		if request.Header.Get("tracestate") != "stale=value" {
			http.Error(w, "mutated caller headers", 500)
			return
		}
		logger.Log("info", "after:"+id, nil)
		_ = json.NewEncoder(w).Encode(downstream)
	})))
	defer upServer.Close()
	const count = 12
	errors := make(chan error, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			request, _ := http.NewRequest("GET", fmt.Sprintf("%s?id=%d", upServer.URL, i), nil)
			if i == 0 {
				request.Header.Set("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00")
				request.Header.Set("tracestate", "vendor=scope")
			}
			if i == 1 {
				request.Header.Set("traceparent", "invalid")
			}
			response, err := httpClient.Do(request)
			if err != nil {
				errors <- err
				return
			}
			defer response.Body.Close()
			var trace TraceContext
			if err = json.NewDecoder(response.Body).Decode(&trace); err != nil {
				errors <- err
				return
			}
			if response.StatusCode != 200 || !validHex(trace.TraceID, 32) {
				errors <- fmt.Errorf("request %d did not inherit a trace: %+v", i, trace)
			}
		}(i)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	up.Logger(context.Background()).Log("info", "outside", nil)
	flush(t, up)
	flush(t, down)
	upLogs, upSpans := traceRecords(t, upSink.snapshot())
	downLogs, downSpans := traceRecords(t, downSink.snapshot())
	if len(upLogs) != 2*count+1 || len(downLogs) != count || len(upSpans) != count || len(downSpans) != count {
		t.Fatalf("unexpected logs/spans: %d/%d/%d/%d", len(upLogs), len(downLogs), len(upSpans), len(downSpans))
	}
	seen := map[string]bool{}
	for i := 0; i < count; i++ {
		upLog, downLog, after := upLogs[fmt.Sprintf("up:%d", i)], downLogs[fmt.Sprintf("down:%d", i)], upLogs[fmt.Sprintf("after:%d", i)]
		trace := hex.EncodeToString(upLog.TraceId)
		if seen[trace] {
			t.Fatal("concurrent requests shared a trace")
		}
		seen[trace] = true
		if trace != hex.EncodeToString(downLog.TraceId) || trace != hex.EncodeToString(after.TraceId) {
			t.Fatal("cross-service logs lost their shared trace")
		}
		root, child := upSpans[hex.EncodeToString(upLog.SpanId)], downSpans[hex.EncodeToString(downLog.SpanId)]
		if root == nil || child == nil || hex.EncodeToString(child.ParentSpanId) != hex.EncodeToString(root.SpanId) || hex.EncodeToString(root.SpanId) != hex.EncodeToString(after.SpanId) {
			t.Fatal("downstream span did not inherit its parent")
		}
		if root.Kind != tracepb.Span_SPAN_KIND_SERVER || child.Kind != tracepb.Span_SPAN_KIND_SERVER {
			t.Fatal("HTTP span kind was not server")
		}
		if i == 0 && (trace != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || root.Flags != 0 || child.Flags != 0 || child.TraceState != "vendor=scope") {
			t.Fatal("incoming trace flags/state were lost")
		}
		if i != 0 && child.TraceState != "" {
			t.Fatal("stale downstream tracestate leaked")
		}
	}
	if len(upLogs["outside"].TraceId) != 0 {
		t.Fatal("request context leaked to an unrelated log")
	}
}

func TestTraceContextProviderSnapshotsOnceAndExplicitContextWins(t *testing.T) {
	sink := &recorder{}
	calls := 0
	external := TraceContext{TraceID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", SpanID: "bbbbbbbbbbbbbbbb", Flags: 1}
	client := testClient(t, Config{Exporter: sink, TraceContextProvider: func(context.Context) (TraceContext, bool) { calls++; return external, true }})
	client.Log(context.Background(), "info", "external", nil)
	if calls != 1 {
		t.Fatalf("provider called %d times for one log", calls)
	}
	explicit := TraceContext{TraceID: "cccccccccccccccccccccccccccccccc", SpanID: "dddddddddddddddd", Flags: 0}
	client.Logger(ContextWithTrace(context.Background(), explicit)).Log("info", "explicit", nil)
	if calls != 1 {
		t.Fatal("explicit context did not override provider")
	}
	external.TraceID = "invalid"
	client.Log(nil, "info", "invalid provider", nil)
	flush(t, client)
	logs, _ := traceRecords(t, sink.snapshot())
	if hex.EncodeToString(logs["external"].TraceId) != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || hex.EncodeToString(logs["explicit"].TraceId) != explicit.TraceID || len(logs["invalid provider"].TraceId) != 0 {
		t.Fatal("provider snapshot/precedence/validation failed")
	}
}

func TestTraceHandlerEndsSpanOnPanic(t *testing.T) {
	sink := &recorder{}
	client := testClient(t, Config{Exporter: sink})
	handler := client.TraceHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("fixture panic") }))
	func() {
		defer func() {
			if recover() == nil {
				t.Error("handler panic was swallowed")
			}
		}()
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	}()
	flush(t, client)
	_, spans := traceRecords(t, sink.snapshot())
	if len(spans) != 1 {
		t.Fatal("panic leaked the request span")
	}
	for _, span := range spans {
		if span.EndTimeUnixNano == 0 || span.GetStatus().GetCode() != tracepb.Status_STATUS_CODE_ERROR {
			t.Fatal("panic span did not end with error")
		}
	}
}
