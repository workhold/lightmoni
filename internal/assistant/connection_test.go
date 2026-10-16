package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
)

type connectionFixtureRuntime func(context.Context, RuntimeInput) error

func (f connectionFixtureRuntime) Run(ctx context.Context, input RuntimeInput, _ func(context.Context, string, json.RawMessage) (any, error), _ func(RuntimeFrame) error) error {
	return f(ctx, input)
}

func connectionRequest(t *testing.T, serverURL string, value any) (int, []byte) {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return request(t, http.DefaultClient, http.MethodPost, serverURL+"/api/v1/assistant/test-connection", string(body))
}

func TestConnectionTestUsesConcreteProtocolAndDoesNotPersist(t *testing.T) {
	protocols := []string{ProtocolOpenAIChat, ProtocolOpenAIResponses, ProtocolAnthropic, ProtocolGoogle}
	for _, protocol := range protocols {
		t.Run(protocol, func(t *testing.T) {
			s, server := fixtureService(t, nil)
			var got RuntimeInput
			s.options.Runtime = connectionFixtureRuntime(func(_ context.Context, input RuntimeInput) error {
				got = input
				return nil
			})

			status, body := connectionRequest(t, server.URL, map[string]any{
				"base_url":         "https://gateway.example/v1/chat/completions",
				"api_key":          "temporary-secret",
				"protocol":         protocol,
				"model":            "fixture-model",
				"reasoning_effort": ReasoningHigh,
				"use_saved_key":    false,
			})
			if status != http.StatusOK || !bytes.Contains(body, []byte(`"ok":true`)) {
				t.Fatalf("connection test: %d %s", status, body)
			}
			if got.Config.BaseURL != "https://gateway.example/v1" || got.Config.Protocol != protocol || got.Config.Model != "fixture-model" || got.Config.APIKey != "temporary-secret" {
				t.Fatalf("runtime config: %+v", got.Config)
			}
			if got.Config.ReasoningEffort != ReasoningHigh {
				t.Fatalf("runtime reasoning effort: %q", got.Config.ReasoningEffort)
			}
			if got.Config.MaxInputTokens != 4096 || got.Config.MaxOutputTokens != 256 || got.Config.MaxSteps != 1 || len(got.Tools) != 0 {
				t.Fatalf("runtime probe limits/tools: %+v tools=%v", got.Config, got.Tools)
			}
			if len(got.Messages) != 1 || got.Messages[0].Role != "user" || got.Messages[0].Content != "Reply with OK only." {
				t.Fatalf("runtime probe message: %+v", got.Messages)
			}
			if _, err := s.options.Store.Get(context.Background(), "config"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("connection test persisted config: %v", err)
			}
			if bytes.Contains(body, []byte("temporary-secret")) {
				t.Fatal("connection response leaked API key")
			}
		})
	}
}

func TestConnectionTestSavedKeyRequiresExactBase(t *testing.T) {
	s, server := fixtureService(t, nil)
	if err := s.options.Store.Put(context.Background(), "config", []byte(`{"base_url":"https://gateway.example/v1","protocol":"openai-chat-completions","model":"saved","api_key":"saved-secret"}`)); err != nil {
		t.Fatal(err)
	}
	var got RuntimeInput
	s.options.Runtime = connectionFixtureRuntime(func(_ context.Context, input RuntimeInput) error { got = input; return nil })
	status, body := connectionRequest(t, server.URL, map[string]any{"base_url": "https://gateway.example/v1", "use_saved_key": true, "protocol": ProtocolOpenAIChat, "model": "saved"})
	if status != http.StatusOK || !bytes.Contains(body, []byte(`"ok":true`)) || got.Config.APIKey != "saved-secret" || got.Config.ReasoningEffort != ReasoningProviderDefault {
		t.Fatalf("saved key: %d %s config=%+v", status, body, got.Config)
	}
	status, body = connectionRequest(t, server.URL, map[string]any{"base_url": "https://gateway.example/other", "use_saved_key": true, "protocol": ProtocolOpenAIChat, "model": "saved"})
	if status != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"saved_key_mismatch"`)) {
		t.Fatalf("cross-base saved key accepted: %d %s", status, body)
	}
}

func TestConnectionTestSavedKeyReadFailureIsSanitized(t *testing.T) {
	s, server := fixtureService(t, nil)
	if err := s.options.Store.Put(context.Background(), "config", []byte(`{"base_url":"https://gateway.example/v1","api_key":"encrypted-secret"}`)); err != nil {
		t.Fatal(err)
	}
	s.decrypt = func(string) (string, error) { return "", errors.New("private decrypt detail") }
	status, body := connectionRequest(t, server.URL, map[string]any{"base_url": "https://gateway.example/v1", "use_saved_key": true, "protocol": ProtocolOpenAIChat, "model": "saved"})
	if status != http.StatusInternalServerError || !bytes.Contains(body, []byte(`"code":"configuration_unavailable"`)) || bytes.Contains(body, []byte("private decrypt")) {
		t.Fatalf("saved key read failure leaked or wrong status: %d %s", status, body)
	}
}

func TestConnectionTestRejectsInvalidInputAndNonAdmin(t *testing.T) {
	s, server := fixtureService(t, nil)
	calls := 0
	s.options.Runtime = connectionFixtureRuntime(func(context.Context, RuntimeInput) error { calls++; return nil })
	for _, value := range []map[string]any{
		{"base_url": "https://gateway.example/v1", "protocol": "auto", "model": "fixture"},
		{"base_url": "https://gateway.example/v1", "protocol": ProtocolOpenAIChat, "model": ""},
		{"base_url": "https://gateway.example/v1", "protocol": "unknown", "model": "fixture"},
		{"base_url": "https://gateway.example/v1", "protocol": ProtocolOpenAIChat, "model": "fixture", "reasoning_effort": "unsupported"},
	} {
		status, _ := connectionRequest(t, server.URL, value)
		if status != http.StatusBadRequest {
			t.Fatalf("invalid input accepted: %d %#v", status, value)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid input reached runtime %d times", calls)
	}
	reqBody := map[string]any{"base_url": "https://gateway.example/v1", "protocol": ProtocolOpenAIChat, "model": "fixture"}
	body, _ := json.Marshal(reqBody)
	req, err := http.NewRequest(http.MethodPost, server.URL+"/api/v1/assistant/test-connection", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Member", "member")
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || calls != 0 {
		t.Fatalf("non-admin connection test: %d calls=%d", resp.StatusCode, calls)
	}
}

func TestConnectionTestSanitizesRuntimeErrorsAndTimeout(t *testing.T) {
	s, server := fixtureService(t, nil)
	s.options.Runtime = connectionFixtureRuntime(func(context.Context, RuntimeInput) error { return errors.New("provider secret response body") })
	status, body := connectionRequest(t, server.URL, map[string]any{"base_url": "https://gateway.example/v1", "protocol": ProtocolOpenAIChat, "model": "fixture"})
	if status != http.StatusBadGateway || !bytes.Contains(body, []byte(`"code":"provider_unavailable"`)) || bytes.Contains(body, []byte("provider secret")) {
		t.Fatalf("runtime error leaked or wrong status: %d %s", status, body)
	}
	s.options.Runtime = connectionFixtureRuntime(func(context.Context, RuntimeInput) error { return context.DeadlineExceeded })
	status, body = connectionRequest(t, server.URL, map[string]any{"base_url": "https://gateway.example/v1", "protocol": ProtocolOpenAIChat, "model": "fixture"})
	if status != http.StatusGatewayTimeout || !bytes.Contains(body, []byte(`"code":"timeout"`)) {
		t.Fatalf("runtime timeout: %d %s", status, body)
	}
}
