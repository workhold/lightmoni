package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestProtocolRepairSharedByDiscoveryTestAndSave(t *testing.T) {
	for _, tc := range []struct {
		protocol, endpoint, version string
	}{
		{ProtocolOpenAIChat, "/chat/completions", "/v1"},
		{ProtocolOpenAIResponses, "/responses", "/v1"},
		{ProtocolAnthropic, "/messages", "/v1"},
		{ProtocolGoogle, "/models/fixture:generateContent", "/v1beta"},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			var directoryCalls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				directoryCalls.Add(1)
				if r.Method != http.MethodGet || r.URL.EscapedPath() != "/tenant%2Fprivate"+tc.version+"/models" {
					t.Errorf("unexpected directory request: %s %s", r.Method, r.URL.EscapedPath())
				}
				if tc.protocol == ProtocolGoogle {
					fmt.Fprint(w, `{"models":[{"name":"models/fixture"}]}`)
				} else {
					fmt.Fprint(w, `{"data":[{"id":"fixture"}]}`)
				}
			}))
			defer provider.Close()
			s, server := fixtureService(t, nil)
			inputBase := provider.URL + "/tenant%2Fprivate/v1beta" + tc.endpoint
			wantBase := provider.URL + "/tenant%2Fprivate" + tc.version
			status, body := modelProtocolRequest(t, server, inputBase, "fresh-key", false, tc.protocol)
			if status != http.StatusOK || decodeModels(t, body).BaseURL != wantBase || directoryCalls.Load() != 1 {
				t.Fatalf("directory normalization: %d %s calls=%d", status, body, directoryCalls.Load())
			}
			var runtimeCalls int
			s.options.Runtime = connectionFixtureRuntime(func(_ context.Context, input RuntimeInput) error {
				runtimeCalls++
				if input.Config.BaseURL != wantBase || input.Config.Protocol != tc.protocol || input.Config.APIKey != "fresh-key" {
					t.Errorf("test connection used a different destination or protocol: %+v", input.Config)
				}
				return nil
			})
			values := map[string]any{"base_url": inputBase, "api_key": "fresh-key", "protocol": tc.protocol, "model": "fixture"}
			status, body = connectionRequest(t, server.URL, values)
			var result connectionTestView
			if err := json.Unmarshal(body, &result); err != nil {
				t.Fatal(err)
			}
			if status != http.StatusOK || !result.OK || result.BaseURL != wantBase || runtimeCalls != 1 {
				t.Fatalf("test normalization: %d %s calls=%d", status, body, runtimeCalls)
			}
			if _, err := s.options.Store.Get(context.Background(), "config"); err != ErrNotFound {
				t.Fatalf("discovery or test persisted configuration: %v", err)
			}
			encoded, _ := json.Marshal(values)
			status, body = request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(encoded))
			cfg, err := s.loadConfig(context.Background())
			if status != http.StatusOK || err != nil || cfg.BaseURL != wantBase || cfg.Protocol != tc.protocol || cfg.Model != "fixture" {
				t.Fatalf("save normalization: %d %s cfg=%+v err=%v", status, body, cfg, err)
			}
			if directoryCalls.Load() != 1 || runtimeCalls != 1 {
				t.Fatal("save performed an implicit provider request")
			}
		})
	}
}

func TestProtocolRepairDoesNotMigrateStoredCredentialIdentity(t *testing.T) {
	for _, protocol := range []string{ProtocolOpenAIChat, ProtocolOpenAIResponses, ProtocolAnthropic} {
		t.Run(protocol, func(t *testing.T) {
			s, server := fixtureService(t, nil)
			stored := []byte(`{"base_url":"https://gateway.example/tenant%2Fprivate/v1beta","protocol":"` + protocol + `","model":"fixture","api_key":"old-key"}`)
			if err := s.options.Store.Put(context.Background(), "config", stored); err != nil {
				t.Fatal(err)
			}
			calls := 0
			s.options.Runtime = connectionFixtureRuntime(func(context.Context, RuntimeInput) error { calls++; return nil })
			status, body := request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/config", "")
			if status != http.StatusOK || !bytes.Contains(body, []byte(`/tenant%2Fprivate/v1beta`)) {
				t.Fatalf("GET silently migrated stored base: %d %s", status, body)
			}
			values := map[string]any{"base_url": "https://gateway.example/tenant%2Fprivate/v1beta", "protocol": protocol, "model": "fixture", "use_saved_key": true}
			status, body = connectionRequest(t, server.URL, values)
			if status != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"saved_key_mismatch"`)) || calls != 0 {
				t.Fatalf("old key sent to repaired destination: %d %s calls=%d", status, body, calls)
			}
			delete(values, "use_saved_key")
			encoded, _ := json.Marshal(values)
			status, body = request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(encoded))
			if status != http.StatusBadRequest {
				t.Fatalf("save migrated stored key: %d %s", status, body)
			}
			after, _ := s.options.Store.Get(context.Background(), "config")
			if !bytes.Equal(stored, after) {
				t.Fatal("rejected repair modified configuration")
			}
			values["clear_key"] = true
			encoded, _ = json.Marshal(values)
			status, body = request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(encoded))
			cfg, err := s.loadConfig(context.Background())
			if status != http.StatusOK || err != nil || cfg.APIKey != "" || cfg.BaseURL != "https://gateway.example/tenant%2Fprivate/v1" {
				t.Fatalf("explicit key clear should permit repair: %d %s cfg=%+v err=%v", status, body, cfg, err)
			}
		})
	}
}

func TestProtocolRepairCanReuseKeyAtAlreadySavedDestination(t *testing.T) {
	s, server := fixtureService(t, nil)
	if err := s.options.Store.Put(context.Background(), "config", []byte(`{"base_url":"https://gateway.example/v1","model":"fixture","api_key":"saved-key"}`)); err != nil {
		t.Fatal(err)
	}
	s.options.Runtime = connectionFixtureRuntime(func(_ context.Context, input RuntimeInput) error {
		if input.Config.BaseURL != "https://gateway.example/v1" || input.Config.APIKey != "saved-key" {
			t.Errorf("saved destination not preserved: %+v", input.Config)
		}
		return nil
	})
	values := map[string]any{"base_url": "https://gateway.example/v1beta/messages", "protocol": ProtocolAnthropic, "model": "fixture", "use_saved_key": true}
	status, body := connectionRequest(t, server.URL, values)
	if status != http.StatusOK {
		t.Fatalf("same destination key was rejected: %d %s", status, body)
	}
	delete(values, "use_saved_key")
	encoded, _ := json.Marshal(values)
	status, body = request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(encoded))
	cfg, err := s.loadConfig(context.Background())
	if status != http.StatusOK || err != nil || cfg.BaseURL != "https://gateway.example/v1" || cfg.APIKey != "saved-key" || cfg.Protocol != ProtocolAnthropic {
		t.Fatalf("same destination key lost on save: %d %s cfg=%+v err=%v", status, body, cfg, err)
	}
}

func TestProtocolEndpointExtractionOccursOnceAcrossEntryPoints(t *testing.T) {
	for _, segment := range []string{"messages", "models", "responses"} {
		t.Run(segment, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.EscapedPath() != "/tenant/"+segment+"/models" {
					t.Errorf("tenant segment was removed: %s", r.URL.EscapedPath())
				}
				fmt.Fprint(w, `{"data":[{"id":"fixture"}]}`)
			}))
			defer provider.Close()
			s, server := fixtureService(t, nil)
			wantBase := provider.URL + "/tenant/" + segment
			inputBase := wantBase + "/messages"
			status, body := modelProtocolRequest(t, server, inputBase, "fresh-key", false, ProtocolAnthropic)
			if status != http.StatusOK || decodeModels(t, body).BaseURL != wantBase {
				t.Fatalf("directory extracted more than one endpoint: %d %s", status, body)
			}
			s.options.Runtime = connectionFixtureRuntime(func(_ context.Context, input RuntimeInput) error {
				if input.Config.BaseURL != wantBase || input.Config.APIKey != "fresh-key" {
					t.Errorf("runtime changed tenant destination: %+v", input.Config)
				}
				return nil
			})
			values := map[string]any{"base_url": inputBase, "api_key": "fresh-key", "protocol": ProtocolAnthropic, "model": "fixture"}
			status, body = connectionRequest(t, server.URL, values)
			if status != http.StatusOK {
				t.Fatalf("test failed: %d %s", status, body)
			}
			encoded, _ := json.Marshal(values)
			status, body = request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(encoded))
			if status != http.StatusOK || !bytes.Contains(body, []byte(`"base_url":"`+wantBase+`"`)) {
				t.Fatalf("save response re-extracted tenant suffix: %d %s", status, body)
			}
			status, body = request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/config", "")
			if status != http.StatusOK || !bytes.Contains(body, []byte(`"base_url":"`+wantBase+`"`)) {
				t.Fatalf("GET re-extracted tenant suffix: %d %s", status, body)
			}
			status, body = modelProtocolRequest(t, server, inputBase, "", true, ProtocolAnthropic)
			if status != http.StatusOK {
				t.Fatalf("saved identity re-extracted tenant suffix: %d %s", status, body)
			}
		})
	}
}
