package moni

import (
	"context"
	"errors"
	"net/http"

	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
)

// Logger binds a request context once, so log calls need no trace argument.
// It is immutable and can be shared by goroutines belonging to that request.
type Logger struct {
	client *Client
	ctx    context.Context
}

func (c *Client) Logger(ctx context.Context) *Logger {
	if ctx == nil {
		ctx = context.Background()
	}
	return &Logger{client: c, ctx: ctx}
}
func (l *Logger) WithTable(table string) *Logger           { return l.client.WithTable(table).Logger(l.ctx) }
func (l *Logger) Log(level, body string, attrs Attributes) { l.client.Log(l.ctx, level, body, attrs) }

// TraceHandler creates one server span per request and inherits incoming W3C
// headers. Business code uses r.Context() or a Logger bound to that context.
func (c *Client) TraceHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, span := c.StartSpan(ExtractHTTP(r.Context(), r.Header), r.Method)
		span.SetKind(tracepb.Span_SPAN_KIND_SERVER)
		defer span.End()
		defer func() {
			if value := recover(); value != nil {
				span.SetError(errors.New("HTTP handler panic"))
				panic(value)
			}
		}()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// TraceTransport propagates the request's current trace to downstream HTTP
// services. It clones headers and never mutates the caller's request.
type TraceTransport struct{ Base http.RoundTripper }

func (t TraceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	copy := request.Clone(request.Context())
	if copy.Header == nil {
		copy.Header = make(http.Header)
	}
	InjectHTTP(copy.Context(), copy.Header)
	return base.RoundTrip(copy)
}
