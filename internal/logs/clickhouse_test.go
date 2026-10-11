package logs

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/query"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
)

// This test only creates/drops its own unique table and its temporary SQLite DB.
func TestClickHouseTimeTypeAndPagination(t *testing.T) {
	endpoint := os.Getenv("LIGHTMONI_LOGS_CH_URL")
	if endpoint == "" {
		t.Skip("set LIGHTMONI_LOGS_CH_URL for isolated real ClickHouse verification")
	}
	ctx := context.Background()
	ch := storage.NewClickHouse(endpoint, "lightmoni", "lightmoni_test_password")
	name := "log_logs_test_" + newID()[:10]
	columns := "event_id String,event_time DateTime64(9,'UTC'),ingested_at DateTime64(9,'UTC'),service String,body String,severity String,source_id String,source_seq Nullable(UInt64),attributes Map(String,String),attributes_json String"
	if e := ch.Exec(ctx, "CREATE TABLE "+name+" ("+columns+") ENGINE=MergeTree ORDER BY (event_time,event_id)"); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := ch.Exec(context.Background(), "DROP TABLE "+name); e != nil {
			t.Error(e)
		}
	})
	base := time.Now().UTC().Truncate(time.Second)
	stamp := func(t time.Time) string { return t.Format("2006-01-02 15:04:05.999999999") }
	data := []map[string]any{}
	for i := 0; i < 8; i++ {
		at := base.Add(time.Second)
		if i == 0 {
			at = base
		}
		if i == 7 {
			at = base.Add(10 * time.Second)
		}
		data = append(data, map[string]any{"event_id": fmt.Sprintf("event-%d", i), "event_time": stamp(at), "ingested_at": stamp(base.Add(2 * time.Second)), "service": "go-demo", "body": "payment failed 中文", "severity": "ERROR", "source_id": "one", "source_seq": i, "attributes": map[string]string{"status": "500", "enabled": "true"}, "attributes_json": `{"status":500,"enabled":true,"empty":""}`})
	}
	for i, n := range []string{"18446744073709551614", "18446744073709551615"} {
		data = append(data, map[string]any{"event_id": fmt.Sprintf("big-%d", i), "event_time": stamp(base.Add(time.Second)), "ingested_at": stamp(base.Add(2 * time.Second)), "service": "go-demo", "body": "large exact sequence", "severity": "INFO", "source_id": "big", "source_seq": n, "attributes": map[string]string{"sequence": n}, "attributes_json": `{"sequence":` + n + `}`})
	}
	if e := ch.Insert(ctx, name, data); e != nil {
		t.Fatal(e)
	}
	db, e := storage.Open(filepath.Join(t.TempDir(), "logs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	cat := func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: name, Name: name, Kind: "log", Columns: fixtureColumns}}, nil
	}
	q := query.New(ch, cat)
	m, e := New(shared.Dependencies{DB: db, Query: q.Execute, Catalog: cat, ReferencedTables: q.ReferencedTables})
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	s := Spec{TableID: name, Range: shared.Range{From: base.Format(time.RFC3339Nano), To: base.Add(10 * time.Second).Format(time.RFC3339Nano)}, Keyword: "中文", Services: []string{"go-demo"}, Filters: []Filter{{Scope: "attribute", Field: "status", Type: "number", Op: "gte", Value: 500}, {Scope: "attribute", Field: "enabled", Type: "boolean", Op: "eq", Value: true}}, Sort: "asc"}
	w := call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s, "limit": 3}, "test")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	v := decoded(t, w)
	if v["total_loaded"] != float64(7) {
		t.Fatal("half-open bounds/type filters wrong", w.Body.String())
	}
	seen := map[string]bool{}
	for {
		for _, row := range v["frame"].(map[string]any)["rows"].([]any) {
			id := row.([]any)[0].(string)
			if seen[id] {
				t.Fatal("duplicate", id)
			}
			seen[id] = true
		}
		if v["next_cursor"] == "" {
			break
		}
		w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"session_id": v["session_id"], "cursor": v["next_cursor"], "limit": 3}, "test")
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		v = decoded(t, w)
	}
	if len(seen) != 7 || seen["event-7"] {
		t.Fatal("pagination failed", seen)
	}
	w = call(t, mux, "POST", "/api/v1/logs/context", map[string]any{"spec": s, "event_id": "event-3", "limit": 2}, "test")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if len(decoded(t, w)["frame"].(map[string]any)["rows"].([]any)) != 5 {
		t.Fatal("wrong source neighbors", w.Body.String())
	}
	aggSpec := s
	aggSpec.Keyword = ""
	aggSpec.Filters = nil
	for _, field := range []string{"service", "severity", "attr:status", "attr:sequence"} {
		w = call(t, mux, "POST", "/api/v1/logs/aggregate", map[string]any{"spec": aggSpec, "field": field}, "test")
		if w.Code != 200 {
			t.Fatal("range aggregation failed", field, w.Code, w.Body.String())
		}
		value := decoded(t, w)
		if fmt.Sprint(value["total"]) != "9" {
			t.Fatal("aggregate total excluded missing values", w.Body.String())
		}
		if field == "attr:sequence" {
			rows := value["frame"].(map[string]any)["rows"].([]any)
			if len(rows) != 2 || fmt.Sprint(value["present"]) != "2" {
				t.Fatal("missing/large sequence groups wrong", w.Body.String())
			}
			if fmt.Sprint(rows[0].([]any)[0]) != "18446744073709551614" || fmt.Sprint(rows[1].([]any)[0]) != "18446744073709551615" {
				t.Fatal("aggregate precision lost", w.Body.String())
			}
		}
	}

	s.Filters = []Filter{{Scope: "attribute", Field: "status", Type: "string", Op: "eq", Value: "500"}}
	w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s}, "test")
	if w.Code != 200 || decoded(t, w)["total_loaded"] != float64(0) {
		t.Fatal("numeric property silently became string", w.Code, w.Body.String())
	}
	s.Keyword = "large exact"
	for _, f := range []Filter{{Scope: "column", Field: "source_seq", Type: "number", Op: "eq", Value: "18446744073709551615"}, {Scope: "attribute", Field: "sequence", Type: "number", Op: "eq", Value: "18446744073709551615"}} {
		s.Filters = []Filter{f}
		w = call(t, mux, "POST", "/api/v1/logs/search", map[string]any{"spec": s}, "test")
		if w.Code != 200 || decoded(t, w)["total_loaded"] != float64(1) {
			t.Fatal("UInt64 precision lost", f.Scope, w.Code, w.Body.String())
		}
	}
}
