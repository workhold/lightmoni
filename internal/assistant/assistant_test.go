package assistant

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
	_ "modernc.org/sqlite"
)

func request(t *testing.T, client *http.Client, method, url, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, b
}
func fixtureService(t *testing.T, tools []Tool) (*Service, *httptest.Server) {
	t.Helper()
	s, err := NewWithOptions(Options{Store: NewMemoryStore(), Actor: func(r *http.Request) (Principal, error) {
		return Principal{ID: "alice", Admin: r.Header.Get("X-Member") == ""}, nil
	}, Tools: tools})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return s, server
}
func configure(t *testing.T, server, provider *httptest.Server) {
	t.Helper()
	body, _ := json.Marshal(Config{BaseURL: provider.URL + "/v1", Model: "fixture", APIKey: "secret-provider-key", Enabled: true})
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(body))
	if status != 200 {
		t.Fatalf("configure: %d %s", status, b)
	}
	if bytes.Contains(b, []byte("secret-provider-key")) {
		t.Fatal("configuration leaked a secret")
	}
}
func createSession(t *testing.T, server *httptest.Server) Session {
	t.Helper()
	status, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions", `{"title":"日志分析"}`)
	if status != 201 {
		t.Fatalf("create: %d %s", status, b)
	}
	var session Session
	if err := json.Unmarshal(b, &session); err != nil {
		t.Fatal(err)
	}
	return session
}

func TestFragmentedToolLoopAndHistory(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer secret-provider-key" {
			t.Error("wrong provider path or authorization")
		}
		var payload struct {
			Messages []Message `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		if calls.Add(1) == 1 {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"list_\",\"arguments\":\"{\"}}]}}]}\n\n")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"tables\",\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n")
		} else {
			last := payload.Messages[len(payload.Messages)-1]
			if last.Role != "tool" || last.ToolCallID != "call-1" || !strings.Contains(last.Content, "log_app") {
				t.Error("tool result was not sent back to model")
			}
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"最近一小时的日志已查询。\"}}]}\n\n")
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer provider.Close()
	var executed atomic.Int32
	_, server := fixtureService(t, []Tool{{Name: "list_tables", Effect: "read", InputSchema: schema(`{"type":"object"}`), Execute: func(_ context.Context, p Principal, raw json.RawMessage) (any, error) {
		if p.ID != "alice" || string(raw) != "{}" {
			t.Error("wrong tool execution scope")
		}
		executed.Add(1)
		return []string{"log_app"}, nil
	}}})
	configure(t, server, provider)
	session := createSession(t, server)
	status, stream := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"分析日志"}`)
	if status != 200 || !bytes.Contains(stream, []byte(`"type":"turn.completed"`)) || !bytes.Contains(stream, []byte(`"type":"tool.result"`)) {
		t.Fatalf("unexpected stream: %d %s", status, stream)
	}
	if executed.Load() != 1 || calls.Load() != 2 {
		t.Fatal("tool loop did not execute exactly once")
	}
	status, b := request(t, server.Client(), "GET", server.URL+"/api/v1/assistant/sessions/"+session.ID, "")
	if status != 200 {
		t.Fatal(status)
	}
	var stored Session
	_ = json.Unmarshal(b, &stored)
	if len(stored.Messages) != 4 || stored.Messages[3].Role != "assistant" {
		t.Fatalf("history not persisted: %+v", stored.Messages)
	}
	for i, event := range stored.Events {
		if i > 0 && event.Sequence <= stored.Events[i-1].Sequence {
			t.Fatal("events are not in strictly increasing order")
		}
	}
}

func TestCancelAndConcurrentTurn(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, ": started\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer provider.Close()
	_, server := fixtureService(t, nil)
	configure(t, server, provider)
	session := createSession(t, server)
	done := make(chan []byte, 1)
	go func() {
		_, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"分析日志"}`)
		done <- b
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("provider did not start")
	}
	status, _ := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"另一条"}`)
	if status != 409 {
		t.Fatalf("concurrent turn accepted: %d", status)
	}
	status, _ = request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/cancel", `{}`)
	if status != 200 {
		t.Fatal(status)
	}
	select {
	case b := <-done:
		if !bytes.Contains(b, []byte(`"type":"turn.cancelled"`)) {
			t.Fatalf("cancelled event missing: %s", b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("turn cancellation did not finish")
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("provider HTTP context was not cancelled")
	}
}

func TestSQLiteRestartAndEncryptedConfiguration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "assistant.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	deps := shared.Dependencies{DB: db, Encrypt: func(s string) (string, error) { return "cipher:" + s, nil }, Decrypt: func(s string) (string, error) { return strings.TrimPrefix(s, "cipher:"), nil }}
	s, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	s.Register(mux)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(shared.WithUser(r.Context(), shared.User{ID: "alice", Role: "admin"})))
	}))
	defer server.Close()
	status, b := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://models.example/v1","model":"model","api_key":"provider-secret","enabled":true}`)
	if status != 200 || bytes.Contains(b, []byte("provider-secret")) {
		t.Fatal("config output leaked secret")
	}
	var raw string
	if err := db.QueryRow(`SELECT value FROM assistant_records WHERE id='config'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "cipher:provider-secret") {
		t.Fatal("host encrypt function not used")
	}
	session := createSession(t, server)
	restarted, err := New(deps)
	if err != nil {
		t.Fatal(err)
	}
	read, err := restarted.getSession(context.Background(), Principal{ID: "alice"}, session.ID)
	if err != nil || read.Title != session.Title {
		t.Fatal("restart lost session")
	}
	if _, err := restarted.getSession(context.Background(), Principal{ID: "bob"}, session.ID); err == nil {
		t.Fatal("another user could read the session")
	}
	status, _ = request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", `{"base_url":"https://models.example/v1","model":"model","enabled":true,"clear_key":true}`)
	if status != 200 {
		t.Fatal(status)
	}
	c, err := restarted.loadConfig(context.Background())
	if err != nil || c.APIKey != "" {
		t.Fatal("clear_key did not clear credential")
	}
}

func TestUnavailableProviderAndStrictInput(t *testing.T) {
	_, server := fixtureService(t, nil)
	session := createSession(t, server)
	status, _ := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"分析日志"}`)
	if status != 503 {
		t.Fatalf("unconfigured provider appears usable: %d", status)
	}
	status, _ = request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions", `{"title":"bad"} invalid`)
	if status != 400 {
		t.Fatal("trailing invalid JSON accepted")
	}
	_, err := NewWithOptions(Options{Store: NewMemoryStore(), Actor: func(*http.Request) (Principal, error) { return Principal{ID: "alice"}, nil }, Tools: []Tool{{Name: "save_dashboard", Effect: "write", InputSchema: schema(`{}`), Execute: func(context.Context, Principal, json.RawMessage) (any, error) { return nil, nil }}}})
	if err == nil {
		t.Fatal("write tool was accepted")
	}
}

func TestProviderPrematureEOFAndNoSecretInError(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/error/chat/completions" {
			w.WriteHeader(401)
			fmt.Fprint(w, "secret-provider-key")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
	}))
	defer provider.Close()
	_, err := streamCompletion(context.Background(), provider.Client(), Config{BaseURL: provider.URL + "/v1", Model: "fixture"}, []Message{{Role: "user", Content: "test"}}, nil, func(string) error { return nil })
	if err == nil {
		t.Fatal("premature EOF accepted")
	}
	_, err = streamCompletion(context.Background(), provider.Client(), Config{BaseURL: provider.URL + "/error", Model: "fixture", APIKey: "secret-provider-key"}, nil, nil, func(string) error { return nil })
	if err == nil || strings.Contains(err.Error(), "secret-provider-key") {
		t.Fatal("provider error leaked credential")
	}
}
