package server

import (
	"context"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/agent"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAgentRuntimePersistsAcrossStorageOutageAndRetry(t *testing.T) {
	s := testGroupServer(t)
	var fail atomic.Bool
	var received []map[string]any
	ch := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if strings.HasPrefix(query, "INSERT") {
			if fail.Load() {
				http.Error(w, "unavailable", 503)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
				var row map[string]any
				if json.Unmarshal([]byte(line), &row) != nil {
					t.Error("invalid stored runtime row")
				}
				received = append(received, row)
			}
		} else {
			io.WriteString(w, `{"data":[]}`)
		}
	}))
	defer ch.Close()
	s.Catalog.CH.URL = ch.URL
	event := agent.RuntimeEvent{ID: "process-1", Time: time.Now().UTC(), Severity: "INFO", Event: "started", Body: "Agent started"}
	body := map[string]any{"agent_id": "mac", "hostname": "local", "queue_batches": 4, "runtime_events": []agent.RuntimeEvent{event}}
	for i := 0; i < 2; i++ {
		if response := groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", body); response.Code != 200 {
			t.Fatal(response.Code, response.Body)
		}
	}
	var pending int
	s.DB.QueryRow("SELECT count(*) FROM agent_runtime_events").Scan(&pending)
	if pending != 1 {
		t.Fatal("retry duplicated durable diagnostic event", pending)
	}
	fail.Store(true)
	if err := s.publishAgentTelemetry(context.Background(), map[string]string{}); err == nil {
		t.Fatal("outage not propagated")
	}
	s.DB.QueryRow("SELECT count(*) FROM agent_runtime_events").Scan(&pending)
	if pending != 1 {
		t.Fatal("outage lost event")
	}
	fail.Store(false)
	if err := s.publishAgentTelemetry(context.Background(), map[string]string{}); err != nil {
		t.Fatal(err)
	}
	s.DB.QueryRow("SELECT count(*) FROM agent_runtime_events").Scan(&pending)
	if pending != 0 {
		t.Fatal("successful durable write not acknowledged")
	}
	foundHeartbeat, foundLog := false, false
	for _, row := range received {
		if row["name"] == "lightmoni.agent.heartbeat" {
			foundHeartbeat = true
			if row["key_id"] != "agent-key" {
				t.Fatal("runtime key attribution lost")
			}
		}
		if row["body"] == "Agent started" {
			foundLog = true
		}
	}
	if !foundHeartbeat || !foundLog {
		t.Fatal("runtime not queryable", received)
	}
}
