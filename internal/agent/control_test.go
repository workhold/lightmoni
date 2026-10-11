package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestControlRegistrationHeartbeatAndConfig(t *testing.T) {
	var mu sync.Mutex
	registered, heartbeat := false, false
	keySafe := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer shared-global-key" {
			t.Error("wrong global control key")
		}
		switch {
		case r.URL.Path == "/api/v1/agents/register":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			registered = body["agent_id"] != "" && body["host_id"] != ""
			_, leaked := body["key"]
			keySafe = keySafe && !leaked
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		case r.Method == http.MethodPost:
			mu.Lock()
			heartbeat = true
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"revision":"remote-1","collect_interval_seconds":5,"probes":[]}`))
		}
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.Endpoint = server.URL
	a := newTestAgent(t, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.controlLoop(ctx) }()
	defer func() { cancel(); <-done }()
	waitFor(t, func() bool { a.mu.RLock(); ready := a.revision == "remote-1"; a.mu.RUnlock(); return ready })
	mu.Lock()
	defer mu.Unlock()
	if !registered || !heartbeat || !keySafe {
		t.Fatalf("invalid control flow: registered=%v heartbeat=%v safe=%v", registered, heartbeat, keySafe)
	}
}
