package agent

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition was not reached")
}

func TestForwardACKLossRetriesSameFrozenBatch(t *testing.T) {
	var mu sync.Mutex
	var bodies [][]byte
	var ids []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, body)
		ids = append(ids, r.Header.Get("X-Lightmoni-Batch-ID"))
		first := len(bodies) == 1
		mu.Unlock()
		if first {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.Endpoint = server.URL
	a := newTestAgent(t, cfg)
	batch := logBatch(t, "app")
	if err := a.Accept(context.Background(), batch, true); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.forwardLoop(ctx) }()
	defer func() { cancel(); <-done }()
	waitFor(t, func() bool { s, _ := a.queue.Stats(context.Background()); return s.Batches == 0 })
	mu.Lock()
	defer mu.Unlock()
	if len(bodies) != 2 || ids[0] != batch.ID || ids[1] != batch.ID || !bytes.Equal(bodies[0], bodies[1]) {
		t.Fatalf("ACK retry changed identity/payload: %v", ids)
	}
	receipt, ok, err := a.queue.Receipt(context.Background(), batch.ID)
	if err != nil || !ok || receipt.ForwardHash != digest(bodies[0]) {
		t.Fatal("completed batch lost durable receipt")
	}
}

func TestPermanentRejectionQuarantinesAcceptedData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(400) }))
	defer server.Close()
	cfg := testConfig(t)
	cfg.Endpoint = server.URL
	a := newTestAgent(t, cfg)
	b := logBatch(t, "app")
	if err := a.Accept(context.Background(), b, true); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); a.forwardLoop(ctx) }()
	defer func() { cancel(); <-done }()
	waitFor(t, func() bool { s, _ := a.queue.Stats(context.Background()); return s.Quarantine == 1 })
	s, _ := a.queue.Stats(context.Background())
	if s.Bytes == 0 || s.Batches != 1 {
		t.Fatal("permanent rejection silently deleted acknowledged data")
	}
	if err := a.queue.Resolve(context.Background(), b.ID, true); err != nil {
		t.Fatal(err)
	}
	var action string
	if err := a.queue.db.QueryRow(`SELECT action FROM queue_actions WHERE batch_id=?`, b.ID).Scan(&action); err != nil || action != "discard" {
		t.Fatal("explicit discard was not audited")
	}
}

func TestCredentialFailurePausesWithoutDiscarding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer server.Close()
	cfg := testConfig(t)
	cfg.Endpoint = server.URL
	a := newTestAgent(t, cfg)
	b := logBatch(t, "app")
	if err := a.Accept(context.Background(), b, true); err != nil {
		t.Fatal(err)
	}
	queued, _, _ := a.queue.Next(context.Background())
	result := a.send(context.Background(), queued)
	if result.permanent || !result.credential || result.retryAfter < 30*time.Second {
		t.Fatalf("bad credential policy: %+v", result)
	}
	s, _ := a.queue.Stats(context.Background())
	if s.Batches != 1 || s.Quarantine != 0 {
		t.Fatal("credential error discarded batch")
	}
}
