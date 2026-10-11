package query

import (
	"context"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQueryBoundary(t *testing.T) {
	allowed := map[string]bool{"log_app": true, "metric_http_sum": true}
	valid := []string{"SELECT count() FROM log_app", "WITH logs AS (SELECT * FROM log_app) SELECT count() FROM logs", "SELECT count() FROM lightmoni.log_app l JOIN metric_http_sum m ON l.service=m.service"}
	for _, s := range valid {
		if _, e := ReferencedTables(s, allowed); e != nil {
			t.Errorf("valid %s: %v", s, e)
		}
	}
	invalid := []string{"DROP TABLE log_app", "SELECT * FROM system.tables", "SELECT * FROM _lm_log_app", "SELECT * FROM numbers(10)", "SELECT * FROM remote('example.org', 'x')", "SELECT * FROM log_app; SELECT 1", "SELECT * FROM log_app SETTINGS max_execution_time=100", "SELECT * FROM log_app FORMAT CSV", "SELECT dictGet('x','a',1) FROM log_app"}
	for _, s := range invalid {
		if _, e := ReferencedTables(s, allowed); e == nil {
			t.Errorf("unsafe SQL accepted: %s", s)
		}
	}
}
func TestMacrosAndLosslessParameters(t *testing.T) {
	r := shared.Range{From: "2026-10-09T10:00:00.000000001+08:00", To: "2026-10-09T11:00:00+08:00"}
	s, params, e := expand("SELECT '$__timeFilter(event_time)' FROM log_app WHERE $__timeFilter(event_time) -- $__timeFilter(fake)\n", r, 1000)
	if e != nil || !strings.Contains(s, "event_time<{") || !strings.Contains(s, "'$__timeFilter(event_time)'") || params["__lm_from"] != "2026-10-09 02:00:00.000000001" {
		t.Fatalf("%s %v %v", s, params, e)
	}
	if _, _, e = expand("SELECT $__timeFilter(event_time;DROP TABLE x)", r, 0); e == nil {
		t.Fatal("invalid macro accepted")
	}
	for _, p := range []shared.Parameter{{Type: "UInt64", Value: json.Number("18446744073709551615")}, {Type: "Int64", Value: "-9223372036854775808"}, {Type: "Bool", Value: true}, {Type: "Array(String)", Value: []any{"a'b", "c\\d"}}, {Type: "Array(String)", Value: []any{}}} {
		if _, e := paramValue(p); e != nil {
			t.Fatal(e)
		}
	}
	for _, p := range []shared.Parameter{{Type: "UInt64", Value: "18446744073709551616"}, {Type: "UInt64", Value: -1}, {Type: "Int64", Value: 1.5}, {Type: "Float64", Value: "NaN"}, {Type: "UInt8", Value: 256}} {
		if _, e := paramValue(p); e == nil {
			t.Fatalf("invalid param accepted %+v", p)
		}
	}
}
func TestTypedResultAndPartialFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("param_big") != "18446744073709551615" {
			t.Error("big integer changed")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"meta":[{"name":"time","type":"DateTime64(9, 'UTC')"},{"name":"big","type":"UInt64"},{"name":"amount","type":"Decimal(38, 9)"}],"data":[{"time":"2026-10-09 02:00:00.000000001","big":"18446744073709551615","amount":"2.000000001"}]}`))
	}))
	defer server.Close()
	executor := New(storage.NewClickHouse(server.URL, "", ""), func(context.Context) ([]shared.Table, error) { return []shared.Table{{Name: "log_app"}}, nil })
	response, e := executor.Execute(context.Background(), shared.QueryRequest{Range: shared.Range{From: "2026-10-09T00:00:00Z", To: "2026-10-10T00:00:00Z"}, Queries: []shared.Query{{RefID: "A", SQL: "SELECT {big:UInt64} AS big FROM log_app", Params: map[string]shared.Parameter{"big": {Type: "UInt64", Value: json.Number("18446744073709551615")}}}, {RefID: "B", SQL: "SELECT * FROM system.tables"}}})
	if e != nil || len(response.Results) != 2 || response.Results[0].Status != "success" || response.Results[1].Status != "error" {
		t.Fatalf("%+v %v", response, e)
	}
	row := response.Results[0].Frames[0].Rows[0]
	if row[0] != "2026-10-09T02:00:00.000000001Z" || row[1] != "18446744073709551615" || row[2] != "2.000000001" {
		t.Fatalf("values changed: %#v", row)
	}
}
