package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type discoveredModels struct {
	BaseURL              string   `json:"base_url"`
	Protocol             string   `json:"protocol"`
	ProtocolOptions      []string `json:"protocol_options"`
	ProtocolSource       string   `json:"protocol_source"`
	RequiresConfirmation bool     `json:"requires_confirmation"`
	CapabilitiesVerified bool     `json:"capabilities_verified"`
	Models               []struct {
		ID string `json:"id"`
	} `json:"models"`
	Truncated bool `json:"truncated"`
}

func modelRequest(t *testing.T, server *httptest.Server, baseURL, key string, reuse bool) (int, []byte) {
	return modelProtocolRequest(t, server, baseURL, key, reuse, "openai-chat-completions")
}

func modelProtocolRequest(t *testing.T, server *httptest.Server, baseURL, key string, reuse bool, protocol string) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"base_url": baseURL, "api_key": key, "use_saved_key": reuse, "protocol": protocol})
	if err != nil {
		t.Fatal(err)
	}
	return request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/models", string(b))
}

func decodeModels(t *testing.T, b []byte) discoveredModels {
	t.Helper()
	var result discoveredModels
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	if result.Models == nil || (result.Protocol != "openai-chat-completions" && result.Protocol != "openai-responses" && result.Protocol != "anthropic-messages" && result.Protocol != "google-generative-ai") {
		t.Fatalf("invalid discovery view: %s", b)
	}
	return result
}

func TestModelProtocolsConfigDefaultConcreteAndKeyReuse(t *testing.T) {
	s, server := fixtureService(t, nil)
	legacy := []byte(`{"base_url":"https://gateway.example/v1","model":"model","api_key":"saved-secret","enabled":true}`)
	if err := s.options.Store.Put(context.Background(), "config", legacy); err != nil {
		t.Fatal(err)
	}
	status, b := request(t, server.Client(), "GET", server.URL+"/api/v1/assistant/config", "")
	if status != 200 || !bytes.Contains(b, []byte(`"protocol":"openai-chat-completions"`)) {
		t.Fatalf("legacy protocol: %d %s", status, b)
	}
	for _, protocol := range []string{"openai-chat-completions", "openai-responses", "anthropic-messages", "google-generative-ai"} {
		body, _ := json.Marshal(map[string]any{"base_url": "https://gateway.example/v1", "model": "model", "protocol": protocol})
		status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
		if status != 200 || !bytes.Contains(b, []byte(`"protocol":"`+protocol+`"`)) {
			t.Fatalf("save concrete %s: %d %s", protocol, status, b)
		}
		stored, _ := s.options.Store.Get(context.Background(), "config")
		if !bytes.Contains(stored, []byte(`"protocol":"`+protocol+`"`)) || !bytes.Contains(stored, []byte("saved-secret")) {
			t.Fatalf("protocol switch lost stored data: %s", stored)
		}
	}
	before, _ := s.options.Store.Get(context.Background(), "config")
	for _, protocol := range []string{"auto", "invalid-protocol"} {
		body, _ := json.Marshal(map[string]any{"base_url": "https://gateway.example/v1", "model": "model", "protocol": protocol})
		status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
		if status != 400 {
			t.Fatalf("invalid saved protocol accepted: %d %s", status, b)
		}
	}
	after, _ := s.options.Store.Get(context.Background(), "config")
	if !bytes.Equal(before, after) {
		t.Fatal("invalid protocol persisted")
	}
}

func TestModelProtocolsManualNativeCatalogs(t *testing.T) {
	for _, tc := range []struct {
		protocol, path, body string
		truncated            bool
		ids                  []string
	}{
		{"openai-responses", "/tenant/v1/responses", `{"data":[{"id":"gpt-model"}]}`, false, []string{"gpt-model"}},
		{"anthropic-messages", "/tenant/v1/messages", `{"data":[{"id":"claude-model","type":"model"}],"has_more":true,"last_id":"claude-model"}`, true, []string{"claude-model"}},
		{"google-generative-ai", "/tenant%2Fprivate/v1beta/models/gemini-model:streamGenerateContent", `{"models":[{"name":"models/gemini-model","supportedGenerationMethods":["generateContent","countTokens"]},{"name":"models/embedding","supportedGenerationMethods":["embedContent"]},{"name":"models/unknown-model"}],"nextPageToken":"opaque-token"}`, true, []string{"gemini-model", "unknown-model"}},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				basePath := "/tenant/v1/models"
				if tc.protocol == "google-generative-ai" {
					basePath = "/tenant%2Fprivate/v1beta/models"
				}
				if r.URL.EscapedPath() != basePath {
					t.Errorf("wrong native catalog path: %s", r.URL.EscapedPath())
				}
				switch tc.protocol {
				case "openai-responses":
					if r.Header.Get("Authorization") != "Bearer native-secret" || r.Header.Get("X-Api-Key") != "" || r.Header.Get("X-Goog-Api-Key") != "" {
						t.Error("wrong OpenAI authentication")
					}
				case "anthropic-messages":
					if r.Header.Get("X-Api-Key") != "native-secret" || r.Header.Get("Anthropic-Version") != "2023-06-01" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("limit") != "500" {
						t.Error("wrong Anthropic authentication/pagination")
					}
				case "google-generative-ai":
					if r.Header.Get("X-Goog-Api-Key") != "native-secret" || r.Header.Get("Authorization") != "" || r.URL.Query().Get("pageSize") != "500" {
						t.Error("wrong Gemini authentication/pagination")
					}
				}
				if r.URL.Query().Get("key") != "" {
					t.Fatal("credential entered query string")
				}
				fmt.Fprint(w, tc.body)
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, b := modelProtocolRequest(t, server, provider.URL+tc.path, "native-secret", false, tc.protocol)
			if status != 200 {
				t.Fatalf("native discovery: %d %s", status, b)
			}
			result := decodeModels(t, b)
			if result.Protocol != tc.protocol || result.ProtocolSource != "manual" || result.RequiresConfirmation || result.CapabilitiesVerified || result.Truncated != tc.truncated || len(result.ProtocolOptions) != 1 || result.ProtocolOptions[0] != tc.protocol || len(result.Models) != len(tc.ids) {
				t.Fatalf("wrong native metadata: %s", b)
			}
			for i, id := range tc.ids {
				if result.Models[i].ID != id {
					t.Fatalf("unexpected native models: %s", b)
				}
			}
		})
	}
}

func TestModelProtocolsAutomaticRecommendations(t *testing.T) {
	for _, tc := range []struct {
		name, body, header, protocol string
		count                        int
		confirm                      bool
	}{
		{"shared-openai", `{"data":[{"id":"claude-is-just-a-name"}]}`, "Authorization", "openai-chat-completions", 1, true},
		{"native-anthropic", `{"data":[{"id":"native-model","type":"model"}],"has_more":false}`, "X-Api-Key", "anthropic-messages", 2, false},
		{"native-google", `{"models":[{"name":"models/native-model","supportedGenerationMethods":["generateContent"]}]}`, "X-Goog-Api-Key", "google-generative-ai", 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get(tc.header) == "" {
					w.WriteHeader(401)
					fmt.Fprint(w, "private-auth-body")
					return
				}
				fmt.Fprint(w, tc.body)
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, b := modelProtocolRequest(t, server, provider.URL+"/v1", "auto-secret", false, "auto")
			if status != 200 {
				t.Fatalf("auto catalog: %d %s", status, b)
			}
			result := decodeModels(t, b)
			if result.Protocol != tc.protocol || result.ProtocolSource != "catalog" || result.RequiresConfirmation != tc.confirm || result.CapabilitiesVerified || calls.Load() != int32(tc.count) {
				t.Fatalf("wrong auto metadata: %s calls=%d", b, calls.Load())
			}
			if tc.confirm && (len(result.ProtocolOptions) != 2 || result.ProtocolOptions[0] != "openai-chat-completions" || result.ProtocolOptions[1] != "openai-responses") {
				t.Fatalf("shared catalog lacks alternatives: %s", b)
			}
		})
	}
}

func TestModelProtocolsTrustedHintsAndManualOverride(t *testing.T) {
	for _, tc := range []struct{ url, manual, protocol, source string }{
		{"https://api.openai.com/v1/models", "auto", "openai-responses", "official-host"},
		{"https://api.anthropic.com/v1/models", "auto", "anthropic-messages", "official-host"},
		{"https://generativelanguage.googleapis.com/v1beta/models", "auto", "google-generative-ai", "official-host"},
		{"https://gateway.example/v1/responses", "auto", "openai-responses", "endpoint-path"},
		{"https://gateway.example/v1/messages", "auto", "anthropic-messages", "endpoint-path"},
		{"https://gateway.example/tenant%2Fv1beta/models/gemini:generateContent", "auto", "google-generative-ai", "endpoint-path"},
		{"https://api.openai.com/v1/models", "anthropic-messages", "anthropic-messages", "manual"},
		{"https://api.openai.com.evil.example/v1/models", "auto", "openai-chat-completions", "catalog"},
	} {
		t.Run(tc.url+tc.manual, func(t *testing.T) {
			s, server := fixtureService(t, nil)
			var calls atomic.Int32
			s.options.HTTPClient = &http.Client{Transport: discoveryRoundTripper(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				body := `{"data":[{"id":"model"}]}`
				if tc.protocol == "google-generative-ai" {
					body = `{"models":[{"name":"models/model"}]}`
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
			})}
			status, b := modelProtocolRequest(t, server, tc.url, "hint-secret", false, tc.manual)
			if status != 200 {
				t.Fatalf("hint discovery: %d %s", status, b)
			}
			result := decodeModels(t, b)
			if result.Protocol != tc.protocol || result.ProtocolSource != tc.source || calls.Load() != 1 || (tc.source != "catalog" && result.RequiresConfirmation) {
				t.Fatalf("wrong hint: %s calls=%d", b, calls.Load())
			}
		})
	}
}

func TestModelProtocolsSavedKeyNoVersionFallbackAndFailureCodes(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(404)
		fmt.Fprint(w, "private-not-found")
	}))
	defer provider.Close()
	_, server := fixtureService(t, nil)
	body, _ := json.Marshal(map[string]any{"base_url": provider.URL, "model": "model", "api_key": "saved-secret"})
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
	if status != 200 {
		t.Fatalf("saved root: %d %s", status, b)
	}
	status, b = modelProtocolRequest(t, server, provider.URL, "", true, "openai-chat-completions")
	if status != 502 || calls.Load() != 1 || !bytes.Contains(b, []byte(`"code":"directory_unsupported"`)) {
		t.Fatalf("saved key fell into version path: %d %s calls=%d", status, b, calls.Load())
	}
	status, b = modelProtocolRequest(t, server, provider.URL+"/other", "", true, "google-generative-ai")
	if status != 400 || calls.Load() != 1 || !bytes.Contains(b, []byte(`"code":"saved_key_mismatch"`)) {
		t.Fatalf("saved mismatch code: %d %s", status, b)
	}
	status, b = modelProtocolRequest(t, server, provider.URL, "", false, "invalid-protocol")
	if status != 400 || calls.Load() != 1 {
		t.Fatalf("invalid discovery protocol contacted provider: %d %s", status, b)
	}
	t.Run("all-auth-profiles-bounded", func(t *testing.T) {
		var authCalls atomic.Int32
		auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authCalls.Add(1)
			w.WriteHeader(401)
			fmt.Fprint(w, "private-auth-secret")
		}))
		defer auth.Close()
		status, b := modelProtocolRequest(t, server, auth.URL+"/v1", "", false, "auto")
		if status != 502 || authCalls.Load() != 3 || !bytes.Contains(b, []byte(`"code":"credentials_rejected"`)) || bytes.Contains(b, []byte("private-auth-secret")) {
			t.Fatalf("auth probes: %d %s calls=%d", status, b, authCalls.Load())
		}
	})
	t.Run("auth-failure-survives-unsupported-profiles", func(t *testing.T) {
		var profileCalls atomic.Int32
		mixed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			profileCalls.Add(1)
			if r.Header.Get("Authorization") != "" {
				w.WriteHeader(401)
			} else {
				w.WriteHeader(404)
			}
			fmt.Fprint(w, "private-auth-response")
		}))
		defer mixed.Close()
		status, b := modelProtocolRequest(t, server, mixed.URL+"/v1", "invalid-secret", false, "auto")
		if status != 502 || profileCalls.Load() != 3 || !bytes.Contains(b, []byte(`"code":"credentials_rejected"`)) || bytes.Contains(b, []byte("private-auth-response")) {
			t.Fatalf("lost credential guidance: %d %s calls=%d", status, b, profileCalls.Load())
		}
	})
}

type metadataFixtureRuntime func(context.Context, RuntimeInput, func(RuntimeFrame) error) error

func (f metadataFixtureRuntime) Run(ctx context.Context, input RuntimeInput, _ func(context.Context, string, json.RawMessage) (any, error), event func(RuntimeFrame) error) error {
	return f(ctx, input, event)
}

func TestNativeMetadataPrivateCheckpointAndPublicSession(t *testing.T) {
	s, server := fixtureService(t, nil)
	session := Session{ID: "metadata-session", UserID: "alice", Messages: []Message{{Role: "user", Content: "inspect"}}}
	checkpoint := `{"type":"checkpoint","messages":[{"role":"assistant","content":"calling","tool_calls":[{"id":"call-1","type":"function","function":{"name":"list_tables","arguments":"{}"},"provider_options":{"google":{"thoughtSignature":"private-tool-signature"}}}]},{"role":"tool","content":"tables","tool_call_id":"call-1"},{"role":"assistant","content":"public signed answer","provider_state":[{"type":"text","text":"public signed answer","provider_options":{"google":{"thoughtSignature":"private-text-signature"}}},{"type":"reasoning","provider_options":{"openai":{"itemId":"private-item-id","reasoningEncryptedContent":"private-ciphertext"}}}]}]}`
	s.options.Runtime = metadataFixtureRuntime(func(_ context.Context, _ RuntimeInput, event func(RuntimeFrame) error) error {
		var frame RuntimeFrame
		if err := json.Unmarshal([]byte(checkpoint), &frame); err != nil {
			return err
		}
		return event(frame)
	})
	err := s.runMastra(context.Background(), Principal{ID: "alice"}, Config{BaseURL: "https://provider.example/v1", Model: "model"}, &session, nil, func(string, map[string]any) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.options.Store.Get(context.Background(), "session/alice/metadata-session")
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-tool-signature", "private-text-signature", "private-ciphertext", "private-item-id"} {
		if !bytes.Contains(stored, []byte(private)) {
			t.Fatalf("private checkpoint lost %s", private)
		}
	}
	status, b := request(t, server.Client(), "GET", server.URL+"/api/v1/assistant/sessions/metadata-session", "")
	if status != 200 {
		t.Fatalf("public session: %d %s", status, b)
	}
	for _, private := range []string{"provider_state", "provider_options", "private-tool-signature", "private-text-signature", "private-ciphertext", "private-item-id"} {
		if bytes.Contains(b, []byte(private)) {
			t.Fatalf("public session exposed %s", private)
		}
	}
	if !bytes.Contains(b, []byte("public signed answer")) {
		t.Fatal("public answer lost")
	}
	after, _ := s.options.Store.Get(context.Background(), "session/alice/metadata-session")
	if !bytes.Equal(stored, after) {
		t.Fatal("public stripping modified private storage")
	}
	s.options.Runtime = metadataFixtureRuntime(func(_ context.Context, input RuntimeInput, _ func(RuntimeFrame) error) error {
		b, _ := json.Marshal(input.Messages)
		for _, private := range []string{"private-tool-signature", "private-text-signature", "private-ciphertext", "private-item-id"} {
			if !bytes.Contains(b, []byte(private)) {
				t.Fatalf("worker replay lost %s", private)
			}
		}
		return nil
	})
	if err := s.runMastra(context.Background(), Principal{ID: "alice"}, Config{BaseURL: "https://provider.example/v1", Model: "model"}, &session, nil, func(string, map[string]any) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestNativeMetadataCheckpointValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		states []map[string]any
	}{
		{"unknown-provider", []map[string]any{{"type": "reasoning", "provider_options": map[string]any{"evil": map[string]string{"secret": "opaque"}}}}},
		{"unknown-field", []map[string]any{{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"plainReasoning": "hidden"}}}}},
		{"reasoning-plaintext", []map[string]any{{"type": "reasoning", "text": "hidden reasoning", "provider_options": map[string]any{"openai": map[string]string{"itemId": "item"}}}}},
		{"signed-hidden-text", []map[string]any{{"type": "text", "text": "hidden reasoning", "provider_options": map[string]any{"google": map[string]string{"thoughtSignature": "signature"}}}}},
		{"invalid-type", []map[string]any{{"type": "tool", "provider_options": map[string]any{"google": map[string]string{"thoughtSignature": "signature"}}}}},
		{"large-field", []map[string]any{{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"reasoningEncryptedContent": strings.Repeat("x", (256<<10)+1)}}}}},
		{"aggregate-limit", []map[string]any{
			{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"reasoningEncryptedContent": strings.Repeat("x", 256<<10)}}},
			{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"reasoningEncryptedContent": strings.Repeat("y", 256<<10)}}},
			{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"reasoningEncryptedContent": strings.Repeat("z", 256<<10)}}},
			{"type": "reasoning", "provider_options": map[string]any{"openai": map[string]string{"reasoningEncryptedContent": strings.Repeat("w", 256<<10)}}},
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := fixtureService(t, nil)
			session := Session{ID: "invalid-metadata", UserID: "alice", Messages: []Message{{Role: "user", Content: "question"}}}
			s.options.Runtime = metadataFixtureRuntime(func(_ context.Context, _ RuntimeInput, event func(RuntimeFrame) error) error {
				b, _ := json.Marshal(map[string]any{"type": "checkpoint", "messages": []map[string]any{{"role": "assistant", "content": "public answer", "provider_state": tc.states}}})
				var frame RuntimeFrame
				if err := json.Unmarshal(b, &frame); err != nil {
					return err
				}
				return event(frame)
			})
			if err := s.runMastra(context.Background(), Principal{ID: "alice"}, Config{BaseURL: "https://provider.example/v1", Model: "model"}, &session, nil, func(string, map[string]any) error { return nil }); err == nil {
				t.Fatal("invalid opaque metadata was accepted")
			}
			if _, err := s.options.Store.Get(context.Background(), "session/alice/invalid-metadata"); !errors.Is(err, ErrNotFound) {
				t.Fatal("invalid metadata persisted")
			}
		})
	}
}

func TestProtectedCredentialsInRuntimePublicFrames(t *testing.T) {
	for _, key := range []string{`secret"quote`, `secret\backslash`} {
		for _, kind := range []string{"event-text", "event-nested", "checkpoint-text", "checkpoint-tool-args", "checkpoint-tool-result", "summary"} {
			t.Run(key+kind, func(t *testing.T) {
				s, _ := fixtureService(t, nil)
				session := Session{ID: "protected-echo", UserID: "alice", Messages: []Message{{Role: "user", Content: "old question"}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: "current question"}}}
				var emitted bool
				s.options.Runtime = metadataFixtureRuntime(func(_ context.Context, _ RuntimeInput, event func(RuntimeFrame) error) error {
					frame := RuntimeFrame{Type: "checkpoint", Messages: []Message{{Role: "assistant", Content: "public answer"}}}
					switch kind {
					case "event-text":
						frame = RuntimeFrame{Type: "event", Name: "assistant.delta", Data: map[string]any{"text": "echo " + key}}
					case "event-nested":
						frame = RuntimeFrame{Type: "event", Name: "tool.result", Data: map[string]any{"nested": []any{map[string]any{"result": "echo " + key}}}}
					case "checkpoint-text":
						frame.Messages[0].Content = "echo " + key
					case "checkpoint-tool-args":
						args, _ := json.Marshal(map[string]string{"query": "echo " + key})
						frame.Messages = []Message{{Role: "assistant", ToolCalls: []ToolCall{{ID: "call", Type: "function", Function: FunctionCall{Name: "run_query", Arguments: string(args)}}}}, {Role: "tool", ToolCallID: "call", Content: "tool result"}}
					case "checkpoint-tool-result":
						frame.Messages = []Message{{Role: "assistant", ToolCalls: []ToolCall{{ID: "call", Type: "function", Function: FunctionCall{Name: "run_query", Arguments: `{}`}}}}, {Role: "tool", ToolCallID: "call", Content: "echo " + key}}
					case "summary":
						frame = RuntimeFrame{Type: "compacted", Through: 2, Summary: "echo " + key}
					}
					return event(frame)
				})
				err := s.runMastra(context.Background(), Principal{ID: "alice"}, Config{BaseURL: "https://provider.example/v1", Model: "model", APIKey: key}, &session, nil, func(string, map[string]any) error { emitted = true; return nil })
				if err == nil || emitted || strings.Contains(err.Error(), key) {
					t.Fatalf("protected credential reached public frame: err=%v emitted=%v", err, emitted)
				}
				if _, err := s.options.Store.Get(context.Background(), "session/alice/protected-echo"); !errors.Is(err, ErrNotFound) {
					t.Fatal("protected public text persisted")
				}
				if strings.Contains(session.Summary, key) {
					t.Fatal("protected summary accepted")
				}
			})
		}
	}
	t.Run("opaque-private-state-is-excluded", func(t *testing.T) {
		s, _ := fixtureService(t, nil)
		key := `secret"quote`
		session := Session{ID: "opaque-credential-bytes", UserID: "alice", Messages: []Message{{Role: "user", Content: "question"}}}
		s.options.Runtime = metadataFixtureRuntime(func(_ context.Context, _ RuntimeInput, event func(RuntimeFrame) error) error {
			return event(RuntimeFrame{Type: "checkpoint", Messages: []Message{{Role: "assistant", Content: "public answer", ProviderState: []ProviderState{{Type: "reasoning", ProviderOptions: ProviderOptions{"openai": {"reasoningEncryptedContent": key}}}}}}})
		})
		if err := s.runMastra(context.Background(), Principal{ID: "alice"}, Config{BaseURL: "https://provider.example/v1", Model: "model", APIKey: key}, &session, nil, func(string, map[string]any) error { return nil }); err != nil {
			t.Fatalf("opaque state treated as public echo: %v", err)
		}
		b, _ := json.Marshal(publicSession(session))
		if bytes.Contains(b, []byte("reasoningEncryptedContent")) {
			t.Fatal("opaque state reached browser")
		}
	})
}

func TestModelDiscoveryNormalizeAndNoPersistence(t *testing.T) {
	for _, path := range []string{"/custom/v2/", "/custom/v2/chat/completions/", "/custom/v2/models", "/tenant%2Fprivate/v1/chat/completions"} {
		t.Run(path, func(t *testing.T) {
			basePath := "/custom/v2"
			if strings.HasPrefix(path, "/tenant") {
				basePath = "/tenant%2Fprivate/v1"
			}
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodGet || r.URL.EscapedPath() != basePath+"/models" || r.Header.Get("Authorization") != "Bearer temporary-secret" {
					t.Errorf("unexpected provider request: %s %s", r.Method, r.URL.EscapedPath())
				}
				fmt.Fprint(w, `{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"},{"id":""},{"id":" "},{"id":"bad\nname"},{"id":"bad\tname"},{"id":"bad\u0000name"},{"id":7}]}`)
			}))
			defer provider.Close()
			s, server := fixtureService(t, nil)
			status, b := modelRequest(t, server, provider.URL+path, "temporary-secret", false)
			if status != 200 {
				t.Fatalf("discover: %d %s", status, b)
			}
			result := decodeModels(t, b)
			if result.BaseURL != provider.URL+basePath || len(result.Models) != 2 || result.Models[0].ID != "a-model" || result.Models[1].ID != "z-model" || result.Truncated || calls.Load() != 1 {
				t.Fatalf("unexpected directory: %s", b)
			}
			if _, err := s.options.Store.Get(context.Background(), "config"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("discovery persisted configuration: %v", err)
			}
			if bytes.Contains(b, []byte("temporary-secret")) {
				t.Fatal("discovery exposed credential")
			}
		})
	}
}

func TestModelDiscoveryRootFallbackAndEmptyDirectory(t *testing.T) {
	for _, first := range []string{"404", "405", "html", "missing-data"} {
		t.Run(first, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				switch r.URL.Path {
				case "/models":
					switch first {
					case "404":
						w.WriteHeader(404)
					case "405":
						w.WriteHeader(405)
					case "html":
						fmt.Fprint(w, "<html>service homepage</html>")
					case "missing-data":
						fmt.Fprint(w, `{"status":"ok"}`)
					}
				case "/v1/models":
					fmt.Fprint(w, `{"data":[]}`)
				default:
					t.Errorf("unexpected path %q", r.URL.Path)
				}
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, b := modelRequest(t, server, provider.URL+"/", "", false)
			if status != 200 {
				t.Fatalf("fallback: %d %s", status, b)
			}
			result := decodeModels(t, b)
			if result.BaseURL != provider.URL+"/v1" || len(result.Models) != 0 || calls.Load() != 2 {
				t.Fatalf("unexpected fallback: %s (calls %d)", b, calls.Load())
			}
		})
	}
}

func TestModelDiscoveryDoesNotRetryOtherFailures(t *testing.T) {
	for _, tc := range []struct {
		name, path     string
		providerStatus int
	}{{"authentication", "", 401}, {"forbidden", "", 403}, {"rate-limit", "", 429}, {"server", "", 500}, {"custom-path", "/tenant/v2", 404}} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(tc.providerStatus)
				fmt.Fprint(w, "provider-secret-response")
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, b := modelRequest(t, server, provider.URL+tc.path, "", false)
			if status != 502 || calls.Load() != 1 || bytes.Contains(b, []byte("provider-secret-response")) {
				t.Fatalf("unsafe provider failure: %d %s calls=%d", status, b, calls.Load())
			}
			if (tc.providerStatus == 401 || tc.providerStatus == 403) && !strings.Contains(string(b), "credential") {
				t.Fatalf("missing credential guidance: %s", b)
			}
		})
	}
}

func TestModelDiscoveryResponseLimits(t *testing.T) {
	t.Run("sorted-deduplicated-model-cap", func(t *testing.T) {
		models := []map[string]any{}
		for i := 510; i >= 0; i-- {
			models = append(models, map[string]any{"id": fmt.Sprintf("model-%03d", i)})
		}
		models = append(models, map[string]any{"id": "model-000"}, map[string]any{"id": strings.Repeat("x", 201)})
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]any{"data": models})
		}))
		defer provider.Close()
		_, server := fixtureService(t, nil)
		status, b := modelRequest(t, server, provider.URL+"/v1", "", false)
		if status != 200 {
			t.Fatalf("limits: %d %s", status, b)
		}
		result := decodeModels(t, b)
		if len(result.Models) != 500 || !result.Truncated || result.Models[0].ID != "model-000" || result.Models[499].ID != "model-499" {
			t.Fatalf("wrong bounded directory: %s", b)
		}
	})
	for _, tc := range []struct{ name, body string }{{"oversized", strings.Repeat("x", (1<<20)+1)}, {"malformed", `{"data":`}, {"null-directory", `{"data":null}`}, {"trailing-json", `{"data":[]} {"data":[]}`}} {
		t.Run(tc.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tc.body) }))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, b := modelRequest(t, server, provider.URL+"/v1", "", false)
			if status != 502 {
				t.Fatalf("invalid body accepted: %d %s", status, b)
			}
		})
	}
}

func TestModelDiscoveryAuthorizationAndInputBeforeProvider(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); fmt.Fprint(w, `{"data":[]}`) }))
	defer provider.Close()
	s, server := fixtureService(t, nil)
	body := fmt.Sprintf(`{"base_url":%q}`, provider.URL)
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/assistant/models", strings.NewReader(body))
	req.Header.Set("X-Member", "1")
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("member status: %d", resp.StatusCode)
	}
	s.options.Actor = func(*http.Request) (Principal, error) { return Principal{}, errors.New("private-auth-error") }
	status, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/models", body)
	if status != 401 || bytes.Contains(b, []byte("private-auth-error")) {
		t.Fatalf("anonymous: %d %s", status, b)
	}
	s.options.Actor = func(*http.Request) (Principal, error) { return Principal{ID: "alice", Admin: true}, nil }
	for _, body := range []string{
		`{"base_url":"https://user:secret@example.com/v1"}`,
		`{"base_url":"https://example.com/v1?key=secret"}`,
		`{"base_url":"https://example.com/v1?"}`,
		`{"base_url":"https://example.com/v1#"}`,
		`{"base_url":"http://example.com:99999/v1"}`,
		`{"base_url":"ftp://example.com/v1"}`,
		`{"base_url":"http:///v1"}`,
		`{"base_url":"http://:80/v1"}`,
		`{"base_url":"https://example.com/v1","unknown":true}`,
		fmt.Sprintf(`{"base_url":%q,"api_key":%q}`, provider.URL, strings.Repeat("x", 4097)),
		fmt.Sprintf(`{"base_url":%q,"api_key":"bad\r\nkey"}`, provider.URL),
		fmt.Sprintf(`{"base_url":%q,"api_key":"bad\tkey"}`, provider.URL),
		fmt.Sprintf(`{"base_url":%q}`, provider.URL+"/"+strings.Repeat("x", 2048)),
		fmt.Sprintf(`{"base_url":%q,"api_key":%q}`, provider.URL, strings.Repeat("x", 17000)),
	} {
		status, b = request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/models", body)
		if status != 400 {
			t.Fatalf("invalid input: %d %s", status, b)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid or unauthorized request contacted provider %d times", calls.Load())
	}
}

func TestModelDiscoverySavedKeyIsolationAndEncryptedStorage(t *testing.T) {
	var calls atomic.Int32
	var expectedKey atomic.Value
	expectedKey.Store("old-secret")
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		want := expectedKey.Load().(string)
		if got := r.Header.Get("Authorization"); (want == "" && got != "") || (want != "" && got != "Bearer "+want) {
			t.Errorf("wrong discovered authorization")
		}
		fmt.Fprint(w, `{"data":[{"id":"model"}]}`)
	}))
	defer provider.Close()
	s, server := fixtureService(t, nil)
	s.encrypt = func(key string) (string, error) { return "encrypted:" + key, nil }
	s.decrypt = func(key string) (string, error) {
		if !strings.HasPrefix(key, "encrypted:") {
			return "", errors.New("bad credential")
		}
		return strings.TrimPrefix(key, "encrypted:"), nil
	}
	configureBody := fmt.Sprintf(`{"base_url":%q,"model":"model","api_key":"old-secret","enabled":true}`, provider.URL+"/tenant/v1")
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", configureBody)
	if status != 200 {
		t.Fatalf("config: %d %s", status, b)
	}
	storedBefore, _ := s.options.Store.Get(context.Background(), "config")
	if !bytes.Contains(storedBefore, []byte("encrypted:old-secret")) {
		t.Fatal("stored discovery credential was not encrypted")
	}
	status, b = modelRequest(t, server, provider.URL+"/tenant/v1/models/", "", true)
	if status != 200 || bytes.Contains(b, []byte("old-secret")) {
		t.Fatalf("saved key: %d %s", status, b)
	}
	if calls.Load() != 1 {
		t.Fatal("saved key did not contact provider once")
	}
	for _, base := range []string{provider.URL + "/other/v1", provider.URL + "/tenant%2Fv1", strings.Replace(provider.URL, "http://", "https://", 1) + "/tenant/v1"} {
		status, b = modelRequest(t, server, base, "", true)
		if status != 400 {
			t.Fatalf("changed base accepted: %d %s", status, b)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("changed base contacted provider with saved key")
	}
	expectedKey.Store("new-secret")
	status, b = modelRequest(t, server, provider.URL+"/other/v1", "new-secret", true)
	if status != 200 {
		t.Fatalf("explicit key precedence: %d %s", status, b)
	}
	expectedKey.Store("")
	status, b = modelRequest(t, server, provider.URL+"/other/v1", "", false)
	if status != 200 {
		t.Fatalf("no-key service: %d %s", status, b)
	}
	storedAfter, _ := s.options.Store.Get(context.Background(), "config")
	if !bytes.Equal(storedBefore, storedAfter) {
		t.Fatal("discovery modified stored config")
	}
	s.decrypt = func(string) (string, error) { return "", errors.New("private-decrypt-secret") }
	status, b = modelRequest(t, server, provider.URL+"/tenant/v1", "", true)
	if status != 500 || bytes.Contains(b, []byte("private-decrypt-secret")) {
		t.Fatalf("decryption failure: %d %s", status, b)
	}
	_, emptyServer := fixtureService(t, nil)
	status, b = modelRequest(t, emptyServer, provider.URL, "", true)
	if status != 400 {
		t.Fatalf("missing saved key: %d %s", status, b)
	}
}

func TestConfigCanonicalBaseAndSavedKeyBoundary(t *testing.T) {
	s, server := fixtureService(t, nil)
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://API.example.com/tenant%2Fprivate/v1/chat/completions/","model":"model","api_key":"saved-secret"}`)
	if status != 200 || !bytes.Contains(b, []byte(`"base_url":"https://api.example.com/tenant%2Fprivate/v1"`)) || !bytes.Contains(b, []byte(`"protocol":"openai-chat-completions"`)) {
		t.Fatalf("canonical config: %d %s", status, b)
	}
	status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://api.example.com/tenant%2Fprivate/v1/models/","model":"model"}`)
	if status != 200 {
		t.Fatalf("same canonical base did not retain key: %d %s", status, b)
	}
	c, _ := s.loadConfig(context.Background())
	if c.APIKey != "saved-secret" {
		t.Fatal("same endpoint lost key")
	}
	before, _ := s.options.Store.Get(context.Background(), "config")
	for _, base := range []string{"https://other.example.com/tenant%2Fprivate/v1", "https://api.example.com/tenant/private/v1", "http://api.example.com/tenant%2Fprivate/v1"} {
		body, _ := json.Marshal(map[string]any{"base_url": base, "model": "model"})
		status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
		if status != 400 || bytes.Contains(b, []byte("saved-secret")) {
			t.Fatalf("changed base preserved key: %d %s", status, b)
		}
	}
	after, _ := s.options.Store.Get(context.Background(), "config")
	if !bytes.Equal(before, after) {
		t.Fatal("rejected save modified config")
	}
	status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://other.example.com/v1","model":"model","api_key":"new-secret"}`)
	if status != 200 {
		t.Fatalf("new key rejected: %d %s", status, b)
	}
	status, b = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://no-key.example.com/v1","model":"model","clear_key":true}`)
	if status != 200 {
		t.Fatalf("explicit clear rejected: %d %s", status, b)
	}
	c, _ = s.loadConfig(context.Background())
	if c.APIKey != "" {
		t.Fatal("clear-key retained old credential")
	}
}

type discoveryRoundTripper func(*http.Request) (*http.Response, error)

func (f discoveryRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestModelDiscoveryRedirectAndTimeoutSanitized(t *testing.T) {
	t.Run("redirect-custom-client", func(t *testing.T) {
		var redirected atomic.Int32
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1); fmt.Fprint(w, `{"data":[]}`) }))
		defer target.Close()
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target.URL+"/models", http.StatusFound)
		}))
		defer provider.Close()
		s, server := fixtureService(t, nil)
		s.options.HTTPClient = provider.Client()
		status, b := modelRequest(t, server, provider.URL+"/v1", "redirect-secret", false)
		if status != 502 || redirected.Load() != 0 || bytes.Contains(b, []byte("redirect-secret")) || bytes.Contains(b, []byte(target.URL)) {
			t.Fatalf("unsafe redirect: %d %s calls=%d", status, b, redirected.Load())
		}
	})
	t.Run("timeout-and-network", func(t *testing.T) {
		for _, failure := range []error{context.DeadlineExceeded, errors.New("private-network-key https://private.invalid")} {
			s, server := fixtureService(t, nil)
			s.options.HTTPClient = &http.Client{Transport: discoveryRoundTripper(func(r *http.Request) (*http.Response, error) {
				deadline, ok := r.Context().Deadline()
				if !ok || deadline.Sub(time.Now()) > 8*time.Second {
					t.Error("discovery request is not bounded to 8 seconds")
				}
				return nil, failure
			})}
			status, b := modelRequest(t, server, "https://provider.example/v1", "network-secret", false)
			want := 502
			if errors.Is(failure, context.DeadlineExceeded) {
				want = 504
			}
			if status != want || bytes.Contains(b, []byte("private-network-key")) || bytes.Contains(b, []byte("network-secret")) {
				t.Fatalf("unsafe transport failure: %d %s", status, b)
			}
		}
	})
	t.Run("body-read-timeout", func(t *testing.T) {
		s, server := fixtureService(t, nil)
		s.options.HTTPClient = &http.Client{Transport: discoveryRoundTripper(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: discoveryErrorBody{}}, nil
		})}
		status, b := modelRequest(t, server, "https://provider.example/v1", "body-secret", false)
		if status != 504 || bytes.Contains(b, []byte("body-secret")) {
			t.Fatalf("body timeout: %d %s", status, b)
		}
	})
}

type discoveryErrorBody struct{}

func TestModelDiscoverySavedRootKeyCannotProbeVersionedBase(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/models" {
			if r.Header.Get("Authorization") != "Bearer saved-root-secret" {
				t.Error("saved key not used at original base")
			}
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"data":[{"id":"fixture"}]}`)
	}))
	defer provider.Close()
	s, server := fixtureService(t, nil)
	body, _ := json.Marshal(Config{BaseURL: provider.URL, Model: "fixture", APIKey: "saved-root-secret"})
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
	if status != 200 {
		t.Fatalf("configure: %d %s", status, b)
	}
	before, _ := s.options.Store.Get(context.Background(), "config")
	status, b = modelRequest(t, server, provider.URL, "", true)
	if status != 502 || calls.Load() != 1 || bytes.Contains(b, []byte("saved-root-secret")) {
		t.Fatalf("saved key probed a new base: %d %s, calls=%d", status, b, calls.Load())
	}
	after, _ := s.options.Store.Get(context.Background(), "config")
	if !bytes.Equal(before, after) {
		t.Fatal("failed discovery changed config")
	}
}

func (discoveryErrorBody) Read([]byte) (int, error) { return 0, context.DeadlineExceeded }
func (discoveryErrorBody) Close() error             { return nil }

func TestCanonicalAPIBaseIdentity(t *testing.T) {
	for _, tc := range []struct{ input, want string }{
		{"https://API.example.com:443/v1/models/", "https://api.example.com/v1"},
		{"HTTPS://API.example.com:0443/v1/models/", "https://api.example.com/v1"},
		{"http://API.example.com:80/v1/chat/completions/", "http://api.example.com/v1"},
		{"http://[::1]:18123/v1/", "http://[::1]:18123/v1"},
		{"http://[::1]:80/", "http://[::1]"},
		{"http://[fe80::1%25En0]:18123/v1/", "http://[fe80::1%25En0]:18123/v1"},
		{"https://api.example.com/tenant%2Fprivate/v1/models", "https://api.example.com/tenant%2Fprivate/v1"},
		{"https://api.example.com/tenant/private/v1/models", "https://api.example.com/tenant/private/v1"},
		{"https://api.example.com/tenant%2fprivate/v1/models", "https://api.example.com/tenant%2fprivate/v1"},
		{"  https://api.example.com/v1/  ", "https://api.example.com/v1"},
	} {
		got, err := canonicalAPIBase(tc.input)
		if err != nil || got != tc.want {
			t.Errorf("canonical %q: got %q (%v), want %q", tc.input, got, err, tc.want)
		}
	}
}

func TestModelDiscoveryRootEmptyNoFallbackAndCancellation(t *testing.T) {
	t.Run("empty-root-directory", func(t *testing.T) {
		var calls atomic.Int32
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			fmt.Fprint(w, `{"data":[]}`)
		}))
		defer provider.Close()
		_, server := fixtureService(t, nil)
		status, b := modelRequest(t, server, provider.URL, "", false)
		if status != 200 || calls.Load() != 1 || decodeModels(t, b).BaseURL != provider.URL {
			t.Fatalf("empty root caused fallback: %d %s (calls %d)", status, b, calls.Load())
		}
	})
	t.Run("caller-cancel-stops-provider", func(t *testing.T) {
		started := make(chan struct{})
		stopped := make(chan struct{})
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-r.Context().Done()
			close(stopped)
		}))
		defer provider.Close()
		_, server := fixtureService(t, nil)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		body, _ := json.Marshal(map[string]any{"base_url": provider.URL + "/v1"})
		req, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/v1/assistant/models", bytes.NewReader(body))
		done := make(chan error, 1)
		go func() {
			resp, err := server.Client().Do(req)
			if resp != nil {
				resp.Body.Close()
			}
			done <- err
		}()
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("provider did not receive discovery")
		}
		cancel()
		select {
		case <-stopped:
		case <-time.After(2 * time.Second):
			t.Fatal("provider request was not canceled")
		}
		if err := <-done; err == nil {
			t.Fatal("caller cancellation did not terminate request")
		}
	})
}
