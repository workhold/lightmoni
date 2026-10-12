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
	"strings"
	"testing"
	"time"
)

func TestSDKSystemRoutingRetainsBusinessAuthorizationAndDeduplication(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(filepath.Join(dir, "runtime.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a, err := auth.New(db, dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("business-key"))
	db.Exec("INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json) VALUES('business','test',?,'2026-10-11','[\"business\"]')", hex.EncodeToString(hash[:]))
	var writes []string
	var stored []map[string]any
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		if strings.HasPrefix(q, "INSERT") {
			writes = append(writes, q)
			raw, _ := io.ReadAll(r.Body)
			for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
				var row map[string]any
				json.Unmarshal([]byte(line), &row)
				stored = append(stored, row)
			}
		} else {
			io.WriteString(w, `{"data":[]}`)
		}
	}))
	defer chServer.Close()
	ch := storage.NewClickHouse(chServer.URL, "test", "")
	catalog, err := NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	accepted := 0
	handler := &Ingest{Catalog: catalog, Auth: a, Accepted: func(_ string, n, _ int) { accepted += n }}
	now := time.Now().UnixNano()
	body, _ := json.Marshal(map[string]any{"resourceMetrics": []any{map[string]any{"resource": map[string]any{"attributes": []any{map[string]any{"key": "service.name", "value": map[string]string{"stringValue": "business-service"}}}}, "scopeMetrics": []any{map[string]any{"metrics": []any{
		map[string]any{"name": "active", "gauge": map[string]any{"dataPoints": []any{map[string]any{"timeUnixNano": now, "asDouble": 2}}}},
		map[string]any{"name": "lightmoni.sdk.heartbeat", "gauge": map[string]any{"dataPoints": []any{map[string]any{"timeUnixNano": now, "asDouble": 1, "attributes": []any{map[string]any{"key": "lightmoni.component", "value": map[string]string{"stringValue": "sdk"}}, map[string]any{"key": "sdk.language", "value": map[string]string{"stringValue": "go"}}}}}}},
	}}}}}})
	send := func(table string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/metrics", bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer business-key")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Lightmoni-Table", table)
		r.Header.Set("X-Lightmoni-Batch-ID", "mixed-runtime")
		w := httptest.NewRecorder()
		handler.receive(w, r, "metrics")
		return w
	}
	for _, table := range []string{"other", "lightmoni_sdk", "lightmoni_center", "lightmoni_agent"} {
		if send(table).Code != 403 {
			t.Fatal("system runtime bypassed credential/table protection", table)
		}
	}
	for i := 0; i < 2; i++ {
		if w := send("business"); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if len(writes) != 2 || accepted != 2 {
		t.Fatal("retry counted or rewrote accepted records", writes, accepted)
	}
	found := false
	for _, q := range writes {
		if strings.Contains(q, "_lm_metric_lightmoni_sdk_gauge") {
			found = true
		}
	}
	if !found {
		t.Fatal("SDK self telemetry did not reach built-in table")
	}
	for _, row := range stored {
		if row["key_id"] != "business" {
			t.Fatal("original key attribution changed")
		}
		if row["name"] == "lightmoni.sdk.heartbeat" && row["attributes"].(map[string]any)["source_table"] != "business" {
			t.Fatal("source table attribution missing")
		}
	}
}
