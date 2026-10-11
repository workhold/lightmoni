package logs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
)

var fixtureColumns = []shared.Column{{Name: "event_id", Type: "String"}, {Name: "event_time", Type: "DateTime64(9,'UTC')"}, {Name: "service", Type: "String"}, {Name: "body", Type: "String"}, {Name: "severity", Type: "String"}, {Name: "source_id", Type: "String"}, {Name: "source_seq", Type: "Nullable(UInt64)"}, {Name: "attributes", Type: "Map(String,String)"}, {Name: "attributes_json", Type: "String"}}

func fixtureRows(n int) [][]any {
	rows := [][]any{}
	for i := 0; i < n; i++ {
		rows = append(rows, []any{fmt.Sprintf("event-%04d", i), "2026-10-10T00:00:00.123456789Z", "go-demo", "same message", "ERROR", "process-a", fmt.Sprint(i), map[string]string{"status": "500"}, `{"status":500}`})
	}
	return rows
}

type queryFixture struct {
	rows     [][]any
	requests []shared.QueryRequest
}

func (f *queryFixture) execute(_ context.Context, req shared.QueryRequest) (shared.QueryResponse, error) {
	f.requests = append(f.requests, req)
	results := []shared.QueryResult{}
	for _, q := range req.Queries {
		frame := shared.Frame{Columns: fixtureColumns, Rows: f.rows}
		if q.RefID == "histogram" {
			frame = shared.Frame{Columns: []shared.Column{{Name: "time", Type: "DateTime64(9,'UTC')"}, {Name: "severity", Type: "String"}, {Name: "count", Type: "UInt64"}}, Rows: [][]any{{"2026-10-10T00:00:00Z", "ERROR", fmt.Sprint(len(f.rows))}}}
		}
		if q.RefID == "groups" {
			frame = shared.Frame{Columns: []shared.Column{{Name: "value", Type: "String"}, {Name: "value_type", Type: "String"}, {Name: "count", Type: "UInt64"}}, Rows: [][]any{{"go-demo", "String", fmt.Sprint(len(f.rows))}}}
		}
		if q.RefID == "totals" {
			frame = shared.Frame{Columns: []shared.Column{{Name: "total", Type: "UInt64"}, {Name: "present", Type: "UInt64"}}, Rows: [][]any{{fmt.Sprint(len(f.rows)), fmt.Sprint(len(f.rows))}}}
		}
		if q.RefID == "anchor" {
			frame.Rows = f.rows[:min(1, len(f.rows))]
		}
		if q.RefID == "before" || q.RefID == "after" {
			frame.Rows = [][]any{}
		}
		results = append(results, shared.QueryResult{RefID: q.RefID, Status: "success", Complete: true, Frames: []shared.Frame{frame}})
	}
	return shared.QueryResponse{Results: results}, nil
}
func newFixture(t *testing.T, n int) (*Module, *http.ServeMux, *queryFixture) {
	t.Helper()
	db, e := storage.Open(filepath.Join(t.TempDir(), "logs.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	f := &queryFixture{rows: fixtureRows(n)}
	deps := shared.Dependencies{DB: db, Query: f.execute, Catalog: func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "log_app", Name: "log_app", Kind: "log", Columns: fixtureColumns}}, nil
	}, ReferencedTables: func(_ context.Context, sql string) ([]string, error) {
		if strings.Contains(sql, "metric_") {
			return []string{"metric_other"}, nil
		}
		return []string{"log_app"}, nil
	}}
	m, e := New(deps)
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	return m, mux, f
}
func specFixture() Spec {
	return Spec{TableID: "log_app", Range: shared.Range{From: "2026-10-10T00:00:00Z", To: "2026-10-10T01:00:00Z"}, Mode: "filters", Sort: "desc"}
}
func call(t *testing.T, mux http.Handler, method, path string, body any, owner string) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	request := httptest.NewRequest(method, path, bytes.NewReader(raw))
	request = request.WithContext(shared.WithUser(request.Context(), shared.User{ID: owner, Role: "member"}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, request)
	return w
}
func decoded(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var v map[string]any
	if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
		t.Fatal(e, w.Body.String())
	}
	return v
}
func TestParameterizedFilterAndValidation(t *testing.T) {
	m, _, _ := newFixture(t, 1)
	s := specFixture()
	s.Keyword = "x%' OR 1=1 --"
	s.Services = []string{"one' OR 1=1"}
	s.Filters = []Filter{{Scope: "attribute", Field: "status' OR 1=1", Type: "number", Op: "gte", Value: 500}, {Scope: "attribute", Field: "missing", Type: "string", Op: "not_exists"}, {Scope: "column", Field: "body", Type: "string", Op: "eq", Value: "' OR 1=1 --"}}
	sql, p, _, e := m.compile(context.Background(), s)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(sql, "OR 1=1") {
		t.Fatal("untrusted input was interpolated", sql)
	}
	if p["lm_log_keyword"].Value != s.Keyword || p["lm_log_0_key"].Value != s.Filters[0].Field {
		t.Fatal("parameters were not preserved")
	}
	if !strings.Contains(sql, "JSONType") || !strings.Contains(sql, "JSONHas") {
		t.Fatal("missing/type semantics absent", sql)
	}
	cases := []Spec{s, s, s, s}
	cases[0].TableID = "log_app; DROP TABLE log_app"
	cases[1].Range.To = cases[1].Range.From
	cases[2].Mode = "sql"
	cases[2].SQL = "SELECT * FROM metric_other"
	cases[3].Filters = []Filter{{Scope: "column", Field: "body", Type: "string", Op: "gt", Value: "x"}}
	for _, bad := range cases {
		if _, _, _, e := m.compile(context.Background(), bad); e == nil {
			t.Fatalf("accepted invalid spec %+v", bad)
		}
	}
}
func TestFrozenPagingSameTimeAndExpiry(t *testing.T) {
	m, mux, f := newFixture(t, 7)
	w := call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": specFixture(), "limit": 3}, "alice")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	v := decoded(t, w)
	id := v["session_id"].(string)
	ids := map[string]bool{}
	collect := func(v map[string]any) {
		for _, row := range v["frame"].(map[string]any)["rows"].([]any) {
			id := row.([]any)[0].(string)
			if ids[id] {
				t.Fatalf("duplicate %s", id)
			}
			ids[id] = true
		}
	}
	collect(v)
	// Mutating the fixture and adding a late event must not mutate cached rows.
	f.rows[3][0] = "late-mutated"
	f.rows = append(f.rows, fixtureRows(1)[0])
	for v["next_cursor"] != "" {
		w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"session_id": id, "cursor": v["next_cursor"], "limit": 3}, "alice")
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		v = decoded(t, w)
		collect(v)
	}
	if len(ids) != 7 || !ids["event-0003"] || ids["late-mutated"] {
		t.Fatal("snapshot changed", ids)
	}
	if len(f.requests) != 1 {
		t.Fatal("continuation queried database", len(f.requests))
	}
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"session_id": id, "cursor": "-1"}, "alice")
	if w.Code != 400 {
		t.Fatal("negative cursor accepted")
	}
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"session_id": id, "cursor": "0"}, "bob")
	if w.Code != 410 {
		t.Fatal("owner isolation absent")
	}
	m.now = func() time.Time { return time.Now().Add(3 * time.Minute) }
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"session_id": id, "cursor": "0"}, "alice")
	if w.Code != 410 {
		t.Fatal("TTL not applied")
	}
}
func TestSessionLimitsAndReadAnchor(t *testing.T) {
	_, mux, _ := newFixture(t, maxRows+2)
	w := call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": specFixture(), "limit": 100, "anchor_id": "event-0530"}, "a")
	v := decoded(t, w)
	if w.Code != 200 || v["truncated"] != true || v["anchor_found"] != true {
		t.Fatal(w.Code, w.Body.String())
	}
	rows := v["frame"].(map[string]any)["rows"].([]any)
	if rows[0].([]any)[0] != "event-0500" {
		t.Fatal("anchor page not restored")
	}
	_, truncated, used, e := freeze(shared.Frame{Columns: fixtureColumns, Rows: [][]any{{strings.Repeat("x", maxBytes+1)}}})
	if e != nil || !truncated || used != 0 {
		t.Fatal("byte bound not applied", used, e)
	}
}
func TestSavedSQLiteCRUDAndRevision(t *testing.T) {
	_, mux, _ := newFixture(t, 1)
	body := map[string]any{"title": "Errors", "spec": specFixture(), "view": map[string]any{"columns": []string{"body"}, "lookback": 60}}
	w := call(t, mux, "POST", "/api/v1/logs/saved-searches", body, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	v := decoded(t, w)
	id := v["id"].(string)
	body["revision"] = float64(1)
	body["title"] = "Changed"
	w = call(t, mux, "PUT", "/api/v1/logs/saved-searches/"+id, body, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(t, mux, "PUT", "/api/v1/logs/saved-searches/"+id, body, "a")
	if w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code)
	}
	w = call(t, mux, "GET", "/api/v1/logs/saved-searches/"+id, nil, "a")
	if decoded(t, w)["title"] != "Changed" {
		t.Fatal("not durably read back")
	}
	for i := 0; i < 3; i++ {
		w = call(t, mux, "GET", "/api/v1/logs/saved-searches", nil, "a")
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	body["title"] = "Copy"
	w = call(t, mux, "POST", "/api/v1/logs/saved-searches", body, "a")
	if decoded(t, w)["id"] == id {
		t.Fatal("copy reused original id")
	}
	w = call(t, mux, "DELETE", "/api/v1/logs/saved-searches/"+id, nil, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(t, mux, "GET", "/api/v1/logs/saved-searches/"+id, nil, "a")
	if w.Code != 404 {
		t.Fatal("deleted record retained")
	}
}
func TestContextAndRealtimeBoundaries(t *testing.T) {
	_, mux, f := newFixture(t, 1)
	s := specFixture()
	s.Keyword = "error"
	s.Filters = []Filter{{Field: "severity", Op: "eq", Type: "string", Value: "ERROR"}}
	w := call(t, mux, "POST", "/api/v1/logs/context", map[string]any{"spec": s, "event_id": "event-0000", "limit": 25}, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	q := f.requests[1].Queries[0]
	if strings.Contains(q.SQL, "positionCaseInsensitiveUTF8") || q.Params["lm_log_source"].Value != "process-a" || q.Params["lm_log_service"].Value != "go-demo" {
		t.Fatal("context scope incorrect", q)
	}
	s.Range = shared.Range{From: time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), To: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	w = call(t, mux, "POST", "/api/v1/logs/tail", map[string]any{"spec": s, "since": time.Now().Add(-3 * time.Minute).UTC().Format(time.RFC3339Nano)}, "a")
	if w.Code != 409 {
		t.Fatal("old polling position accepted")
	}
	w = call(t, mux, "POST", "/api/v1/logs/tail", map[string]any{"spec": s, "since": time.Now().Add(-3 * time.Second).UTC().Format(time.RFC3339Nano)}, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	q = f.requests[len(f.requests)-1].Queries[0]
	if !strings.Contains(q.SQL, "ingested_at>=") || !strings.Contains(q.SQL, "ORDER BY ingested_at ASC,event_id ASC") {
		t.Fatal("tail uses event-time cursor", q.SQL)
	}
}

func TestHistogramSharesSessionBudgetAndIsImmutable(t *testing.T) {
	m, mux, _ := newFixture(t, 1)
	hist := shared.Frame{Columns: []shared.Column{{Name: "time", Type: "DateTime64(9,'UTC')"}, {Name: "severity", Type: "String"}, {Name: "count", Type: "UInt64"}}, Rows: [][]any{{"2026-10-10T00:00:00Z", strings.Repeat("A", maxBytes-300), "1"}}}
	m.deps.Query = func(_ context.Context, req shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{RefID: "rows", Status: "success", Complete: true, Frames: []shared.Frame{{Columns: fixtureColumns, Rows: fixtureRows(1)}}}, {RefID: "histogram", Status: "success", Complete: true, Frames: []shared.Frame{hist}}}}, nil
	}
	w := call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": specFixture()}, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	v := decoded(t, w)
	id := v["session_id"].(string)
	s, ok := m.get(id, "a")
	if !ok || s.Bytes > maxBytes {
		t.Fatal("combined row/histogram budget exceeded")
	}
	hist.Rows[0][2] = "99"
	hist.Columns[0].Name = "changed"
	if s.Histogram.Rows[0][2] != "1" || s.Histogram.Columns[0].Name != "time" {
		t.Fatal("histogram mutated after freeze")
	}
	hist.Rows[0][1] = strings.Repeat("A", maxBytes)
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": specFixture()}, "a")
	if w.Code != 200 || decoded(t, w)["histogram_truncated"] != true {
		t.Fatal("histogram truncation was hidden", w.Code)
	}
}

func TestRangeAggregationAndBucketLimits(t *testing.T) {
	_, mux, fixture := newFixture(t, 7)
	s := specFixture()
	s.IntervalMS = 60000
	w := call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s}, "a")
	if w.Code != 200 || decoded(t, w)["interval_ms"] != float64(60000) {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call(t, mux, "POST", "/api/v1/logs/aggregate", map[string]any{"spec": s, "field": "service"}, "a")
	if w.Code != 200 || decoded(t, w)["total"] != "7" {
		t.Fatal(w.Code, w.Body.String())
	}
	key := "attr:x' OR 1=1 --"
	w = call(t, mux, "POST", "/api/v1/logs/aggregate", map[string]any{"spec": s, "field": key}, "a")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	req := fixture.requests[len(fixture.requests)-1]
	if strings.Contains(req.Queries[0].SQL, "OR 1=1") || req.Queries[0].Params["lm_log_agg_field"].Value != "x' OR 1=1 --" {
		t.Fatal("attribute key not parameterized", req)
	}
	for _, field := range []string{"service;DROP TABLE log_app", "attributes", "unknown"} {
		w = call(t, mux, "POST", "/api/v1/logs/aggregate", map[string]any{"spec": s, "field": field}, "a")
		if w.Code != 400 {
			t.Fatal(field, w.Code)
		}
	}
	s.IntervalMS = 1000
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s}, "a")
	if w.Code != 400 {
		t.Fatal("unbounded time buckets accepted", w.Code)
	}
	s.IntervalMS = 234
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s}, "a")
	if w.Code != 400 {
		t.Fatal("unsupported time bucket accepted", w.Code)
	}
}
