package moni

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestCenterEndpointSelectionAndAddressUpdate(t *testing.T) {
	var mu sync.Mutex
	privateURL, publicURL, revision, identity := "", "", "one", "same"
	privateCredentials := 0
	seen := []string{}
	handler := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("content-type", "application/json")
			if r.URL.Path == "/v1/center-identity" {
				if r.Header.Get("Authorization") != "" {
					t.Error("probe sent credentials")
				}
				id := "same"
				if name == "private" {
					id = identity
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"center_id": id})
				return
			}
			if name == "private" && r.Header.Get("Authorization") != "" {
				privateCredentials++
			}
			if r.URL.Path == "/v1/center-endpoints" {
				_ = json.NewEncoder(w).Encode(map[string]any{"version": 1, "center_id": "same", "revision": revision, "endpoints": []centerAddress{{privateURL, "internal"}, {publicURL, "public"}}})
				return
			}
			seen = append(seen, name)
			_, _ = w.Write([]byte("{}"))
		}
	}
	public := httptest.NewServer(handler("public"))
	defer public.Close()
	publicURL = public.URL
	private := httptest.NewServer(handler("private"))
	defer private.Close()
	privateURL = private.URL
	client, err := New(Config{Service: "routing", Table: "business", Endpoint: publicURL, Key: "secret", DisableSelfTelemetry: true, DisableRemoteConfig: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.Shutdown(ctx)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = client.RefreshEndpoints(ctx); err != nil {
		t.Fatal(err)
	}
	counter, _ := client.Counter("requests", MetricOptions{})
	counter.Add(ctx, 1, nil)
	if err = client.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if seen[len(seen)-1] != "private" {
		t.Fatal(seen)
	}
	mu.Unlock()
	private.Close()
	counter.Add(ctx, 1, nil)
	if err = client.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if seen[len(seen)-1] != "public" {
		t.Fatal(seen)
	}
	mu.Unlock()
	replacement := httptest.NewServer(handler("replacement"))
	defer replacement.Close()
	mu.Lock()
	privateURL = replacement.URL
	revision = "two"
	mu.Unlock()
	if err = client.RefreshEndpoints(ctx); err != nil {
		t.Fatal(err)
	}
	counter.Add(ctx, 1, nil)
	if err = client.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if seen[len(seen)-1] != "replacement" {
		t.Fatal(seen)
	}
	mu.Unlock()
	// Retired private addresses receive no authorized discovery after identity changes.
	bad := httptest.NewServer(handler("private"))
	defer bad.Close()
	mu.Lock()
	privateURL = bad.URL
	identity = "other"
	revision = "three"
	before := privateCredentials
	mu.Unlock()
	if err = client.RefreshEndpoints(ctx); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if privateCredentials != before {
		t.Error("foreign private address received credentials")
	}
	mu.Unlock()
}

func TestCenterEndpointWaitHonorsDeadline(t *testing.T) {
	selector := newCenterEndpoints("http://127.0.0.1:1")
	selector.mu.Lock()
	defer selector.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := selector.resolve(ctx, http.DefaultClient, "", false); err == nil {
		t.Fatal("expected cancellation")
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("blocked beyond context deadline")
	}
	for _, url := range []string{"http://:80", "http://example:70000", "http://u:p@example", "http://example?q=1"} {
		if validCenterURL(url) {
			t.Errorf("accepted %s", url)
		}
	}
}
