package ingest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/storage"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func metricPayload() []byte {
	stamp := strconv.FormatInt(time.Now().UnixNano(), 10)
	return []byte(`{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"two-services-same-key"}}]},"scopeMetrics":[{"metrics":[{"name":"requests","sum":{"aggregationTemporality":1,"isMonotonic":true,"dataPoints":[{"timeUnixNano":"` + stamp + `","asInt":"20"}]}},{"name":"active","gauge":{"dataPoints":[{"timeUnixNano":"` + stamp + `","asDouble":2}]}}]}]}]}`)
}
func TestPartialCommitRetryAndCredentialRotation(t *testing.T) {
	dir := t.TempDir()
	db, e := storage.Open(filepath.Join(dir, "main.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	a, e := auth.New(db, dir, "http://localhost")
	if e != nil {
		t.Fatal(e)
	}
	for _, key := range []string{"first-key", "second-key"} {
		sum := sha256.Sum256([]byte(key))
		_, e = db.Exec(`INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json)VALUES(?,?,?,?,'["app"]')`, key, key, hex.EncodeToString(sum[:]), time.Now().Format(time.RFC3339))
		if e != nil {
			t.Fatal(e)
		}
	}
	calls := 0
	committed := []map[string]any{}
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		var row map[string]any
		if e := json.Unmarshal(bytes.TrimSpace(raw), &row); e != nil {
			t.Error(e)
		}
		committed = append(committed, row)
		if calls == 1 {
			http.Error(w, "commit happened but ack failed", 503)
		}
	}))
	defer chServer.Close()
	ch := storage.NewClickHouse(chServer.URL, "writer", "fixture")
	catalog, e := NewCatalog(db, ch, ch)
	if e != nil {
		t.Fatal(e)
	}
	for _, subtype := range []string{"sum", "gauge"} {
		name := "metric_app_" + subtype
		_, e = db.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json)VALUES(?,?,'app','metric',?,'[]','[]')", name, name, subtype)
		if e != nil {
			t.Fatal(e)
		}
	}
	ingest := &Ingest{Catalog: catalog, Auth: a}
	raw := metricPayload()
	send := func(key string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/metrics", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+key)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Lightmoni-Table", "app")
		r.Header.Set("X-Lightmoni-Batch-ID", "stable-batch")
		w := httptest.NewRecorder()
		ingest.receive(w, r, "metrics")
		return w
	}
	if w := send("first-key", raw); w.Code != 503 {
		t.Fatalf("partial write ACK: %d %s", w.Code, w.Body)
	}
	if w := send("second-key", raw); w.Code != 200 {
		t.Fatalf("retry: %d %s", w.Code, w.Body)
	}
	before := calls
	if w := send("second-key", raw); w.Code != 200 || calls != before {
		t.Fatal("completed batch rewritten")
	}
	unique := map[string]bool{}
	for _, row := range committed {
		unique[row["event_id"].(string)] = true
		if row["key_id"] != "first-key" {
			t.Fatal("retry credential rewrote original attribution")
		}
	}
	if len(unique) != 2 || len(committed) != 3 {
		t.Fatalf("stable records: %d %d", len(unique), len(committed))
	}
	if w := send("first-key", append(raw, ' ')); w.Code != 400 {
		t.Fatal("conflicting frozen batch accepted")
	}
}
func TestOTLPJSONHexAndInvalidData(t *testing.T) {
	nano := strconv.FormatInt(time.Now().UnixNano(), 10)
	raw := []byte(`{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"browser"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"` + nano + `","traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","body":{"stringValue":"test"}}]}]}]}`)
	rows, e := normalize("logs", raw, "application/json", "2026-10-09 00:00:00.000000000", "key")
	if e != nil || len(rows) != 1 || rows[0].Row["trace_id"] != "0123456789abcdef0123456789abcdef" || rows[0].Row["span_id"] != "0123456789abcdef" {
		t.Fatalf("hex IDs: %+v %v", rows, e)
	}
	if _, e = normalize("logs", bytes.ReplaceAll(raw, []byte("0123456789abcdef0123456789abcdef"), []byte("invalid")), "application/json", "", "key"); e == nil {
		t.Fatal("invalid trace accepted")
	}
	histogram := `{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"host"}}]},"scopeMetrics":[{"metrics":[{"name":"latency","histogram":{"dataPoints":[{"timeUnixNano":"` + nano + `","count":"1","explicitBounds":[2],"bucketCounts":["1","0"],"sum":"NaN"}]}}]}]}]}`
	if _, e = normalize("metrics", []byte(histogram), "application/json", "", "key"); e == nil || !strings.Contains(e.Error(), "finite") {
		t.Fatalf("nonfinite histogram: %v", e)
	}
}

func TestTableScopesEnforcedBeforeIngestion(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(filepath.Join(dir, "scopes.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a, err := auth.New(db, dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("web-key"))
	_, err = db.Exec(`INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json) VALUES('web-key','web',?,'2026-10-11','["web"]')`, hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	writes := 0
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writes++
		if !strings.HasPrefix(r.URL.Query().Get("query"), "INSERT INTO _lm_") {
			t.Error("unexpected table creation", r.URL.Query().Get("query"))
		}
	}))
	defer chServer.Close()
	ch := storage.NewClickHouse(chServer.URL, "writer", "fixture")
	catalog, err := NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"log_web", "metric_web_sum", "metric_web_gauge", "trace_web"} {
		_, err = db.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json) VALUES(?,?,'web',?,'','[]','[]')", name, name, strings.Split(name, "_")[0])
		if err != nil {
			t.Fatal(err)
		}
	}
	service := &Ingest{Catalog: catalog, Auth: a}
	mux := http.NewServeMux()
	service.Register(mux)
	nano := strconv.FormatInt(time.Now().UnixNano(), 10)
	payloads := map[string][]byte{
		"logs":    []byte(`{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"browser"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"` + nano + `","body":{"stringValue":"web log"}}]}]}]}`),
		"metrics": metricPayload(),
		"traces":  []byte(`{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"browser"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","startTimeUnixNano":"` + nano + `","endTimeUnixNano":"` + nano + `","name":"web request"}]}]}]}`),
	}
	send := func(signal, table, batch string, body io.Reader, contentType string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/v1/"+signal, body)
		request.Header.Set("Authorization", "Bearer web-key")
		request.Header.Set("X-Lightmoni-Table", table)
		request.Header.Set("X-Lightmoni-Batch-ID", batch)
		request.Header.Set("Content-Type", contentType)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	for _, signal := range []string{"logs", "metrics", "traces"} {
		for _, contentType := range []string{"application/json", "application/x-protobuf"} {
			for _, table := range []string{"host", "probe", "web_extra", "unregistered"} {
				before := writes
				response := send(signal, table, "denied-"+signal+table, unreadBody{t}, contentType)
				if response.Code != 403 || writes != before {
					t.Fatalf("unauthorized %s/%s: %d %s", signal, table, response.Code, response.Body)
				}
			}
		}
		response := send(signal, "web", "allowed-"+signal, bytes.NewReader(payloads[signal]), "application/json")
		if response.Code != 200 {
			t.Fatalf("allowed %s: %d %s", signal, response.Code, response.Body)
		}
	}
	var batches, tables, errors int
	_ = db.QueryRow("SELECT count(*) FROM ingest_batches").Scan(&batches)
	_ = db.QueryRow("SELECT count(*) FROM catalog").Scan(&tables)
	_ = db.QueryRow("SELECT error_count FROM ingest_keys WHERE id='web-key'").Scan(&errors)
	if batches != 3 || tables != 4 || errors != 24 || writes != 4 {
		t.Fatalf("unexpected side effects: batches=%d tables=%d errors=%d writes=%d", batches, tables, errors, writes)
	}
	// Revocation must apply to retries, including batches already acknowledged.
	_, err = db.Exec(`UPDATE ingest_keys SET allowed_tables_json='["mobile"]' WHERE id='web-key'`)
	if err != nil {
		t.Fatal(err)
	}
	response := send("logs", "web", "allowed-logs", unreadBody{t}, "application/json")
	if response.Code != 403 || writes != 4 {
		t.Fatal("completed retry bypassed new permissions")
	}
	_, err = db.Exec(`UPDATE ingest_keys SET allowed_tables_json='[]' WHERE id='web-key'`)
	if err != nil {
		t.Fatal(err)
	}
	if response := send("logs", "mobile", "empty-scope", unreadBody{t}, "application/json"); response.Code != 403 {
		t.Fatal("empty grants allowed writes")
	}
	_, err = db.Exec("UPDATE ingest_keys SET active=0 WHERE id='web-key'")
	if err != nil {
		t.Fatal(err)
	}
	if response := send("logs", "web", "disabled", unreadBody{t}, "application/json"); response.Code != 401 {
		t.Fatal("disabled key accepted")
	}
}

type unreadBody struct{ t *testing.T }

func (body unreadBody) Read([]byte) (int, error) {
	body.t.Error("unauthorized body read before permission check")
	return 0, io.EOF
}

func TestAllTableKeyIngestsNewTablesAndCanBeRestricted(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(filepath.Join(dir, "all-tables.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a, err := auth.New(db, dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("all-key"))
	_, err = db.Exec(`INSERT INTO ingest_keys(id,name,token_hash,created_at,allow_all_tables) VALUES('all-key','all tables',?,'2026-10-11',1)`, hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	writes := 0
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if strings.HasPrefix(query, "INSERT INTO _lm_") {
			writes++
		} else if strings.Contains(query, "system.columns") {
			_, _ = w.Write([]byte(`{"data":[]}`))
		}
	}))
	defer chServer.Close()
	ch := storage.NewClickHouse(chServer.URL, "writer", "fixture")
	catalog, err := NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	service := &Ingest{Catalog: catalog, Auth: a}
	mux := http.NewServeMux()
	service.Register(mux)
	nano := strconv.FormatInt(time.Now().UnixNano(), 10)
	payloads := map[string][]byte{
		"logs":    []byte(`{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"all-qa"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"all tables log"}}]}]}]}`),
		"metrics": metricPayload(),
		"traces":  []byte(`{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"all-qa"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","startTimeUnixNano":"` + nano + `","endTimeUnixNano":"` + nano + `","name":"all tables request"}]}]}]}`),
	}
	send := func(signal, table string) *httptest.ResponseRecorder {
		request := httptest.NewRequest("POST", "/v1/"+signal, bytes.NewReader(payloads[signal]))
		request.Header.Set("Authorization", "Bearer all-key")
		request.Header.Set("X-Lightmoni-Table", table)
		request.Header.Set("X-Lightmoni-Batch-ID", "all-"+signal)
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	for _, signal := range []string{"logs", "metrics", "traces"} {
		if response := send(signal, "future_"+signal); response.Code != 200 {
			t.Fatalf("all-table %s failed: %d %s", signal, response.Code, response.Body)
		}
	}
	var tables int
	_ = db.QueryRow("SELECT count(*) FROM catalog").Scan(&tables)
	if writes != 4 || tables != 4 {
		t.Fatalf("new tables not ingested: writes=%d tables=%d", writes, tables)
	}
	if response := send("logs", "log_private"); response.Code != 400 {
		t.Fatal("all-table key bypassed logical table validation")
	}
	_, err = db.Exec(`UPDATE ingest_keys SET allow_all_tables=0,allowed_tables_json='["web"]' WHERE id='all-key'`)
	if err != nil {
		t.Fatal(err)
	}
	for _, signal := range []string{"logs", "metrics", "traces"} {
		if response := send(signal, "future_"+signal); response.Code != 403 || writes != 4 {
			t.Fatal("all-table permission survived restriction", signal)
		}
	}
}
