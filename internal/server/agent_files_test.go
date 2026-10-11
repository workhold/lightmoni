package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/storage"
)

// Exercise enrollment, remote tasks, the real file loop, durable forwarding,
// whitelist enforcement and OTLP normalization. Only ClickHouse's HTTP storage
// boundary is substituted; this does not prove a physical database installation.
func TestAgentDirectoryLogsThroughGroupControlAndIngest(t *testing.T) {
	s := testGroupServer(t)
	if _, err := s.DB.Exec(`UPDATE ingest_keys SET allow_all_tables=0,allowed_tables_json='["logs_a","logs_b"]' WHERE id='agent-key'`); err != nil {
		t.Fatal(err)
	}
	type written struct {
		table string
		row   map[string]any
	}
	writes := make(chan written, 20)
	clickhouse := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if strings.HasPrefix(query, "INSERT INTO ") {
			decoder := json.NewDecoder(r.Body)
			for {
				var row map[string]any
				if err := decoder.Decode(&row); err != nil {
					if err != io.EOF {
						t.Error(err)
					}
					break
				}
				writes <- written{table: strings.Fields(query)[2], row: row}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"meta":[],"data":[]}`))
	}))
	defer clickhouse.Close()
	s.Catalog.CH = storage.NewClickHouse(clickhouse.URL, "qa", "")
	s.Catalog.Reader = s.Catalog.CH
	(&ingest.Ingest{Catalog: s.Catalog, Auth: s.Auth}).Register(s.Public)
	endpoint := httptest.NewServer(s.Public)
	defer endpoint.Close()
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("first 中文\n"), 0600); err != nil {
		t.Fatal(err)
	}
	on, off := true, false
	tasks := agent.RemoteConfig{CollectIntervalSeconds: 15, HostEnabled: &off, LogsEnabled: &on, LogTable: "logs_a", LogSources: []agent.LogSource{{Directory: dir, Pattern: "*.log*", FromBeginning: true}}}
	first := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "日志分组 A", "config": tasks}))
	tasks.LogTable = "logs_b"
	second := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "日志分组 B", "config": tasks}))
	cfg := agent.DefaultConfig()
	cfg.Endpoint = endpoint.URL
	cfg.Key = "agent-test-key"
	cfg.GroupID = first.ID
	cfg.DataDir = t.TempDir()
	cfg.Listen = "127.0.0.1:0"
	cfg.ControlIntervalSeconds = 1
	runtime, err := agent.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
		runtime.Close()
	}()
	next := func() written {
		t.Helper()
		select {
		case value := <-writes:
			return value
		case <-time.After(8 * time.Second):
			t.Fatal("directory log did not reach ingest")
			return written{}
		}
	}
	value := next()
	if value.table != "_lm_log_logs_a" || value.row["body"] != "first 中文" || value.row["agent_id"] != runtime.ID() || value.row["key_id"] != "agent-key" || value.row["source_id"] == "" {
		t.Fatal(value)
	}
	attributes := value.row["attributes"].(map[string]any)
	if attributes["file_path"] != path || attributes["event_time_source"] != "observed" {
		t.Fatal(attributes)
	}
	if response := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/"+runtime.ID()+"/group", map[string]string{"group_id": second.ID}); response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, err := runtime.Status(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if status["config_revision"] == second.Config.Revision {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime did not apply platform regroup")
		}
		time.Sleep(20 * time.Millisecond)
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = file.WriteString("second after regroup\n")
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	value = next()
	if value.table != "_lm_log_logs_b" || value.row["body"] != "second after regroup" {
		t.Fatal(value)
	}
	if tasks := remoteTasks(t, s, runtime.ID()); tasks.GroupID != second.ID {
		t.Fatal("enrollment group overwrote platform selection")
	}
	var rejected int
	if err = s.DB.QueryRow(`SELECT count(*) FROM key_events WHERE status='rejected'`).Scan(&rejected); err != nil {
		t.Fatal(err)
	}
	if rejected != 0 {
		t.Fatal("agent attempted a default table outside its key permissions")
	}
}
