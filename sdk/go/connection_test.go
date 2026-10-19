package moni

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func connectionEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{"LIGHTMONI_MODE", "LIGHTMONI_ENDPOINT", "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE", "LIGHTMONI_KEY", "LIGHTMONI_AGENT_ENDPOINT", "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE"} {
		t.Setenv(name, "")
	}
}

type connectionReceipt struct {
	method, path, authorization, batchID, body string
}

type connectionReceiver struct {
	server   *httptest.Server
	mu       sync.Mutex
	requests []connectionReceipt
	status   atomic.Int32
}

func newConnectionReceiver(t *testing.T) *connectionReceiver {
	t.Helper()
	r := &connectionReceiver{}
	r.status.Store(http.StatusOK)
	r.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		r.mu.Lock()
		r.requests = append(r.requests, connectionReceipt{req.Method, req.URL.Path, req.Header.Get("Authorization"), req.Header.Get("X-Lightmoni-Batch-ID"), string(body)})
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(int(r.status.Load()))
		if req.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"revision":"local-fixture","log_sampling":{},"disable_rules":[]}`)
		} else {
			_, _ = io.WriteString(w, "{}")
		}
	}))
	t.Cleanup(r.server.Close)
	return r
}

func (r *connectionReceiver) snapshot() []connectionReceipt {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]connectionReceipt(nil), r.requests...)
}

func connectionClient(t *testing.T, cfg Config) *Client {
	t.Helper()
	cfg.DisableSelfTelemetry, cfg.DisableRemoteConfig = true, true
	client, err := NewFromEnv("connection-test", "business", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.Shutdown(ctx)
	})
	return client
}

func TestExplicitConnectionRoutesIsolateUnusedSecrets(t *testing.T) {
	for _, mode := range []ConnectionMode{ModeDirect, ModeAgent} {
		t.Run(string(mode), func(t *testing.T) {
			connectionEnvironment(t)
			platform, agent := newConnectionReceiver(t), newConnectionReceiver(t)
			t.Setenv("LIGHTMONI_MODE", string(mode))
			t.Setenv("LIGHTMONI_ENDPOINT", platform.server.URL)
			t.Setenv("LIGHTMONI_AGENT_ENDPOINT", agent.server.URL)
			t.Setenv("LIGHTMONI_DATA_KEY", "data-key")
			t.Setenv("LIGHTMONI_LOCAL_TOKEN", "local-token")
			cfg := Config{}
			selected, unused, key := platform, agent, "data-key"
			if mode == ModeDirect {
				t.Setenv("LIGHTMONI_LOCAL_TOKEN_FILE", "/missing-lightmoni-unused-local")
				cfg.LocalToken, cfg.LocalTokenFile = "unused-explicit", "/missing-lightmoni-explicit-local"
			} else {
				t.Setenv("LIGHTMONI_DATA_KEY_FILE", "/missing-lightmoni-unused-data")
				t.Setenv("LIGHTMONI_KEY", "unused-legacy")
				cfg.Key, cfg.DataKeyFile = "unused-explicit", "/missing-lightmoni-explicit-data"
				selected, unused, key = agent, platform, "local-token"
			}
			client := connectionClient(t, cfg)
			if err := client.RefreshConfig(context.Background()); err != nil {
				t.Fatal(err)
			}
			client.Log(context.Background(), "info", "selected route", nil)
			flush(t, client)
			requests := selected.snapshot()
			if len(requests) != 2 || requests[0].method != http.MethodGet || requests[0].path != "/v1/sdk-config" || requests[1].method != http.MethodPost || requests[1].path != "/v1/logs" {
				t.Fatalf("unexpected selected route requests: %+v", requests)
			}
			for _, request := range requests {
				if request.authorization != "Bearer "+key {
					t.Fatal("selected route used the wrong credential")
				}
			}
			if len(unused.snapshot()) != 0 || client.Stats().SelectedRoute != string(mode) {
				t.Fatal("explicit mode contacted the other endpoint or changed route")
			}
		})
	}
}

func TestSelectedConnectionSourceChecksAndInvalidMode(t *testing.T) {
	for _, mode := range []ConnectionMode{ModeDirect, ModeAgent} {
		t.Run(string(mode), func(t *testing.T) {
			connectionEnvironment(t)
			t.Setenv("LIGHTMONI_MODE", string(mode))
			t.Setenv("LIGHTMONI_ENDPOINT", "http://127.0.0.1:1")
			t.Setenv("LIGHTMONI_AGENT_ENDPOINT", "http://127.0.0.1:2")
			variable := "LIGHTMONI_DATA_KEY"
			if mode == ModeAgent {
				variable = "LIGHTMONI_LOCAL_TOKEN"
			}
			t.Setenv(variable+"_FILE", "/missing-lightmoni-selected-secret")
			if _, err := NewFromEnv("test", "business", Config{}); err == nil || !strings.Contains(err.Error(), "file") {
				t.Fatalf("selected file was not validated: %v", err)
			}
			file := filepath.Join(t.TempDir(), "secret")
			if err := os.WriteFile(file, []byte("file-value\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv(variable+"_FILE", file)
			t.Setenv(variable, "env-value")
			if _, err := NewFromEnv("test", "business", Config{}); err == nil || !strings.Contains(err.Error(), "credential_source_conflict") {
				t.Fatalf("selected file/env conflict was not rejected: %v", err)
			}
			t.Setenv(variable+"_FILE", "")
			cfg := Config{Key: "explicit-value"}
			if mode == ModeAgent {
				cfg = Config{LocalToken: "explicit-value"}
			}
			if _, err := NewFromEnv("test", "business", cfg); err == nil || !strings.Contains(err.Error(), "credential_source_conflict") {
				t.Fatalf("selected explicit/env conflict was not rejected: %v", err)
			}
		})
	}
	t.Run("legacy conflict", func(t *testing.T) {
		connectionEnvironment(t)
		t.Setenv("LIGHTMONI_MODE", "direct")
		t.Setenv("LIGHTMONI_DATA_KEY", "new")
		t.Setenv("LIGHTMONI_KEY", "old")
		if _, err := NewFromEnv("test", "business", Config{}); err == nil || !strings.Contains(err.Error(), "credential_source_conflict: LIGHTMONI_KEY") {
			t.Fatalf("direct legacy conflict was not rejected: %v", err)
		}
	})
	t.Run("invalid mode before secrets", func(t *testing.T) {
		connectionEnvironment(t)
		t.Setenv("LIGHTMONI_MODE", "invalid")
		t.Setenv("LIGHTMONI_LOCAL_TOKEN_FILE", "/missing-local")
		t.Setenv("LIGHTMONI_DATA_KEY_FILE", "/missing-data")
		if _, err := NewFromEnv("test", "business", Config{}); err == nil || !strings.Contains(err.Error(), "mode must be") {
			t.Fatalf("mode was not rejected before reading secrets: %v", err)
		}
		if _, err := New(Config{Mode: "invalid", DataKeyFile: "/missing-data"}); err == nil || !strings.Contains(err.Error(), "mode must be") {
			t.Fatalf("explicit mode was not rejected before reading secrets: %v", err)
		}
	})
	t.Run("auto keeps both source checks", func(t *testing.T) {
		connectionEnvironment(t)
		t.Setenv("LIGHTMONI_MODE", "auto")
		t.Setenv("LIGHTMONI_LOCAL_TOKEN_FILE", "/missing-auto-local")
		if _, err := NewFromEnv("test", "business", Config{}); err == nil || !strings.Contains(err.Error(), "file") {
			t.Fatalf("auto source validation changed: %v", err)
		}
	})
}

func TestExplicitConnectionFailureDoesNotChangeRoute(t *testing.T) {
	for _, mode := range []ConnectionMode{ModeDirect, ModeAgent} {
		t.Run(string(mode), func(t *testing.T) {
			connectionEnvironment(t)
			platform, agent := newConnectionReceiver(t), newConnectionReceiver(t)
			t.Setenv("LIGHTMONI_MODE", string(mode))
			t.Setenv("LIGHTMONI_ENDPOINT", platform.server.URL)
			t.Setenv("LIGHTMONI_DATA_KEY", "data-key")
			t.Setenv("LIGHTMONI_AGENT_ENDPOINT", agent.server.URL)
			t.Setenv("LIGHTMONI_LOCAL_TOKEN", "local-token")
			selected, unused := platform, agent
			if mode == ModeAgent {
				selected, unused = agent, platform
			}
			selected.status.Store(http.StatusServiceUnavailable)
			client := connectionClient(t, Config{RetryMin: time.Millisecond, RetryMax: 2 * time.Millisecond})
			client.Log(context.Background(), "info", "retained batch", nil)
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			err := client.Flush(ctx)
			cancel()
			if err == nil || len(selected.snapshot()) == 0 || len(unused.snapshot()) != 0 {
				t.Fatal("failure did not retain the selected route")
			}
			selected.status.Store(http.StatusOK)
			flush(t, client)
			requests := selected.snapshot()
			for _, request := range requests {
				if request.method != http.MethodPost || request.path != "/v1/logs" || request.batchID != requests[0].batchID || request.body != requests[0].body {
					t.Fatal("retry changed endpoint, batch identity or payload")
				}
			}
			if len(unused.snapshot()) != 0 {
				t.Fatal("retry contacted the unselected endpoint")
			}
		})
	}
}

func TestExplicitAgentConfigUsesSelectedRouteAndPreservesCustomExporter(t *testing.T) {
	connectionEnvironment(t)
	platform, agent := newConnectionReceiver(t), newConnectionReceiver(t)
	client := testClient(t, Config{Mode: ModeAgent, AgentEndpoint: agent.server.URL, LocalToken: "local-token", ConfigEndpoint: platform.server.URL, ConfigKey: "unused-data-key", DisableRemoteConfig: true})
	if err := client.RefreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(platform.snapshot()) != 0 || len(agent.snapshot()) != 1 || agent.snapshot()[0].authorization != "Bearer local-token" {
		t.Fatal("explicit Agent configuration bypassed the selected route or local credential")
	}
	custom := testClient(t, Config{Mode: ModeAgent, Exporter: &recorder{}, ConfigEndpoint: platform.server.URL, ConfigKey: "custom-config-key", DisableRemoteConfig: true})
	if err := custom.RefreshConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(platform.snapshot()) != 1 || platform.snapshot()[0].authorization != "Bearer custom-config-key" || len(agent.snapshot()) != 1 {
		t.Fatal("custom exporter configuration endpoint changed")
	}
}
