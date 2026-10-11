package dashboards

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/query"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/lightmoni/lightmoni/internal/shared"
	_ "modernc.org/sqlite"
)

func testModule(t *testing.T, path string) (*sql.DB, *http.ServeMux) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	m, err := New(shared.Dependencies{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	return db, mux
}
func request(t *testing.T, mux *http.ServeMux, method, path string, body any) (int, Dashboard) {
	t.Helper()
	var encoded []byte
	if body != nil {
		encoded, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	var out Dashboard
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}
func sample() Dashboard {
	return Dashboard{Title: "机器总览", Panels: []Panel{{Title: "CPU", Type: "line", Queries: []Query{{RefID: "A", SQL: "SELECT 1 AS value", Params: map[string]shared.Parameter{"count": {Type: "UInt64", Value: "18446744073709551615"}}}}, Options: map[string]any{"x": "time", "y": "value"}}}}
}

func TestSQLiteCreateReadConflictCopyAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dashboards.db")
	db, mux := testModule(t, path)
	code, d := request(t, mux, "POST", "/api/v1/dashboards", sample())
	if code != 201 || d.Revision != 1 || d.Panels[0].ID == "" {
		t.Fatalf("create: %d %#v", code, d)
	}
	code, read := request(t, mux, "GET", "/api/v1/dashboards/"+d.ID, nil)
	if code != 200 || read.Panels[0].Queries[0].Params["count"].Value != "18446744073709551615" {
		t.Fatalf("read: %d %#v", code, read)
	}
	stale := d
	d.Title = "已保存"
	code, d = request(t, mux, "PUT", "/api/v1/dashboards/"+d.ID, d)
	if code != 200 || d.Revision != 2 {
		t.Fatalf("update: %d %#v", code, d)
	}
	code, _ = request(t, mux, "PUT", "/api/v1/dashboards/"+d.ID, stale)
	if code != 409 {
		t.Fatalf("stale update: %d", code)
	}
	code, copy := request(t, mux, "POST", "/api/v1/dashboards/"+d.ID+"/copy", map[string]string{"title": "独立副本"})
	if code != 201 || copy.ID == d.ID || copy.Panels[0].ID == d.Panels[0].ID || copy.Revision != 1 {
		t.Fatalf("copy: %d %#v", code, copy)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, mux = testModule(t, path)
	defer db.Close()
	code, read = request(t, mux, "GET", "/api/v1/dashboards/"+d.ID, nil)
	if code != 200 || read.Title != "已保存" || read.Revision != 2 {
		t.Fatalf("restart: %d %#v", code, read)
	}
	code, _ = request(t, mux, "DELETE", "/api/v1/dashboards/"+d.ID+"?revision=1", nil)
	if code != 409 {
		t.Fatalf("stale delete: %d", code)
	}
	code, _ = request(t, mux, "DELETE", "/api/v1/dashboards/"+d.ID+"?revision=2", nil)
	if code != 200 {
		t.Fatalf("delete: %d", code)
	}
	code, _ = request(t, mux, "GET", "/api/v1/dashboards/"+d.ID, nil)
	if code != 404 {
		t.Fatalf("deleted read: %d", code)
	}
	code, read = request(t, mux, "GET", "/api/v1/dashboards/"+copy.ID, nil)
	if code != 200 || read.Title != "独立副本" {
		t.Fatalf("copy retained: %d", code)
	}
}
func TestInvalidDefinitionsRejected(t *testing.T) {
	db, mux := testModule(t, filepath.Join(t.TempDir(), "test.db"))
	defer db.Close()
	for _, change := range []func(*Dashboard){func(d *Dashboard) { d.Title = " " }, func(d *Dashboard) { d.Panels[0].Type = "plugin" }, func(d *Dashboard) { d.Panels[0].Grid = Grid{X: 10, W: 6, H: 5} }, func(d *Dashboard) { d.Panels[0].Queries = append(d.Panels[0].Queries, d.Panels[0].Queries[0]) }, func(d *Dashboard) { d.Variables = []Variable{{Name: "bad name", Type: "custom"}} }, func(d *Dashboard) { d.Refresh = 1 }} {
		d := sample()
		change(&d)
		code, _ := request(t, mux, "POST", "/api/v1/dashboards", d)
		if code != 400 {
			t.Fatalf("invalid definition accepted: %d %#v", code, d)
		}
	}
}

func TestOverwriteIsFencedAndKeepsVersionHistory(t *testing.T) {
	db, mux := testModule(t, filepath.Join(t.TempDir(), "versions.db"))
	defer db.Close()
	_, original := request(t, mux, "POST", "/api/v1/dashboards", sample())
	path := "/api/v1/dashboards/" + original.ID
	draft := original
	draft.Title = "我的布局"
	other := original
	other.Title = "他人的布局"
	_, other = request(t, mux, "PUT", path, other)
	encoded, _ := json.Marshal(draft)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("PUT", path, bytes.NewReader(encoded)))
	var conflict struct {
		Code    string    `json:"code"`
		Current Dashboard `json:"current"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &conflict)
	if w.Code != 409 || conflict.Code != "revision_conflict" || conflict.Current.Revision != 2 {
		t.Fatalf("conflict: %d %s", w.Code, w.Body.String())
	}
	other.Title = "又一次更新"
	_, other = request(t, mux, "PUT", path, other)
	input := struct {
		Dashboard
		OverwriteRevision int64 `json:"overwrite_revision"`
	}{draft, 2}
	if code, _ := request(t, mux, "PUT", path, input); code != 409 {
		t.Fatalf("outdated confirmation must conflict: %d", code)
	}
	input.OverwriteRevision = 3
	code, saved := request(t, mux, "PUT", path, input)
	if code != 200 || saved.Revision != 4 || saved.Title != draft.Title {
		t.Fatalf("overwrite: %d %#v", code, saved)
	}
	var count, forced, base int
	if err := db.QueryRow("SELECT count(*) FROM dashboard_versions WHERE dashboard_id=?", original.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT overwritten,base_revision FROM dashboard_versions WHERE dashboard_id=? AND revision=4", original.ID).Scan(&forced, &base); err != nil {
		t.Fatal(err)
	}
	if count != 4 || forced != 1 || base != 3 {
		t.Fatalf("history: %d forced=%d base=%d", count, forced, base)
	}
}

func TestVariablePlanningRejectsCyclesAndIgnoresSQLText(t *testing.T) {
	d := sample()
	d.Variables = []Variable{{Name: "a", Type: "query", SQL: "SELECT {b:String}"}, {Name: "b", Type: "query", SQL: "SELECT {a:String}"}}
	if err := normalize(&d); err == nil {
		t.Fatal("cycle accepted")
	}
	d.Variables = []Variable{{Name: "a", Type: "query", SQL: "SELECT '{a:String}' /* {a:String} */ -- {a:String}\n"}}
	if err := normalize(&d); err != nil {
		t.Fatalf("quoted variable is not a dependency: %v", err)
	}
	d.Range = shared.Range{From: "2026-10-10T13:00:00Z", To: "2026-10-10T12:00:00Z"}
	if err := normalize(&d); err == nil {
		t.Fatal("reversed range accepted")
	}
}

func TestAlertDraftUsesPublicASTAndPreservesParameters(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "alerts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	deps := shared.Dependencies{DB: db, Catalog: func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "logs-id", Name: "log_app"}, {ID: "metric-id", Name: "metric_http_sum"}}, nil
	}, ReferencedTables: func(_ context.Context, sql string) ([]string, error) {
		return query.ReferencedTables(sql, map[string]bool{"log_app": true, "metric_http_sum": true})
	}}
	m, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	input := map[string]any{"query": shared.Query{RefID: "B", SQL: "SELECT count() FROM log_app WHERE service={service:String}", Params: map[string]shared.Parameter{"service": {Type: "String", Value: "订单'API"}}}, "range": shared.Range{From: "2026-10-10T11:00:00Z", To: "2026-10-10T12:00:00Z"}}
	body, _ := json.Marshal(input)
	r := httptest.NewRequest("POST", "/api/v1/dashboards/alert-draft", bytes.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("draft: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		SQL    string                      `json:"sql"`
		IDs    []string                    `json:"source_table_ids"`
		Params map[string]shared.Parameter `json:"params"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.IDs) != 1 || out.IDs[0] != "logs-id" || out.Params["service"].Value != "订单'API" {
		t.Fatalf("invalid draft: %#v", out)
	}
	input["query"] = shared.Query{RefID: "A", SQL: "SELECT * FROM system.tables"}
	body, _ = json.Marshal(input)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/dashboards/alert-draft", bytes.NewReader(body)))
	if w.Code != 400 {
		t.Fatal("private/system source accepted")
	}
}
