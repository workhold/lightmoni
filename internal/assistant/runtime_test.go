package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func workerForTest(t *testing.T) *MastraRuntime {
	t.Helper()
	entry, _ := filepath.Abs("../../ai-runtime/dist/runner.js")
	if _, err := os.Stat(entry); err != nil {
		t.Skip("build ai-runtime before integration tests")
	}
	return &MastraRuntime{Entry: entry}
}

func TestActualMastraWorkerToolHistoryAndUsage(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Error("missing provider authorization")
		}
		var payload struct {
			Messages []Message `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		w.Header().Set("Content-Type", "text/event-stream")
		if requests.Add(1) == 1 {
			fmt.Fprint(w, "data: {\"id\":\"a\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"list_tables\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n")
		} else {
			found := false
			for _, m := range payload.Messages {
				if m.Role == "tool" && strings.Contains(m.Content, "log_app") {
					found = true
				}
			}
			if !found {
				t.Error("host tool receipt missing from provider history")
			}
			fmt.Fprint(w, "data: {\"id\":\"b\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"已检查数据表\"},\"finish_reason\":null}]}\n\n")
			fmt.Fprint(w, "data: {\"id\":\"b\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":8,\"total_tokens\":50}}\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer provider.Close()
	input := RuntimeInput{System: "Inspect tables", Config: Config{BaseURL: provider.URL + "/v1", Model: "fixture", APIKey: "fixture-secret", MaxInputTokens: 32000, MaxOutputTokens: 4096, MaxSteps: 8}, Messages: []Message{{Role: "user", Content: "查表"}}, Tools: []RuntimeTool{{Name: "list_tables", Description: "list", Schema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}}}
	var calls int
	var events []RuntimeFrame
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := workerForTest(t).Run(ctx, input, func(_ context.Context, name string, args json.RawMessage) (any, error) {
		calls++
		if name != "list_tables" {
			t.Error(name)
		}
		return map[string]any{"tables": []string{"log_app"}}, nil
	}, func(f RuntimeFrame) error { events = append(events, f); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || requests.Load() != 2 {
		t.Fatalf("calls=%d requests=%d", calls, requests.Load())
	}
	text, usage, checkpoint := false, false, false
	for _, f := range events {
		b, _ := json.Marshal(f)
		if strings.Contains(string(b), "fixture-secret") {
			t.Fatal("secret leaked")
		}
		if f.Name == "assistant.delta" {
			text = true
		}
		if f.Name == "turn.usage" {
			usage = true
		}
		if f.Type == "checkpoint" && len(f.Messages) > 0 {
			checkpoint = true
		}
	}
	if !text || !usage || !checkpoint {
		t.Fatalf("missing events text=%v usage=%v checkpoint=%v", text, usage, checkpoint)
	}
}

func TestActualMastraWorkerCancellation(t *testing.T) {
	entered := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		select {
		case entered <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer provider.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	worker := workerForTest(t)
	go func() {
		done <- worker.Run(ctx, RuntimeInput{System: "test", Config: Config{BaseURL: provider.URL, Model: "fixture", MaxInputTokens: 32000, MaxOutputTokens: 256, MaxSteps: 2}, Messages: []Message{{Role: "user", Content: "wait"}}}, nil, func(RuntimeFrame) error { return nil })
	}()
	select {
	case <-entered:
	case <-time.After(15 * time.Second):
		t.Fatal("model request never started")
	}
	start := time.Now()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancel succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("worker not cancelled")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("slow cancel")
	}
}

func fixtureAnswer(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":%q},\"finish_reason\":null}]}\n\n", text)
	fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":42,\"completion_tokens\":8,\"total_tokens\":50}}\n\ndata: [DONE]\n\n")
}
func fixtureTool(w http.ResponseWriter, name string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":%q,\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", name)
}
func TestMastraHostRoundTripAndLimits(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []Message `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		n := requests.Add(1)
		if n == 1 {
			fixtureTool(w, "list_tables")
			return
		}
		if n == 3 {
			if len(payload.Messages) != 6 {
				t.Errorf("next turn history length %d, want system+user+assistant+tool+assistant+user", len(payload.Messages))
			}
		}
		fixtureAnswer(w, "结果已核实")
	}))
	defer provider.Close()
	s, server := fixtureService(t, []Tool{{Name: "list_tables", InputSchema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`), Effect: "read", Execute: func(context.Context, Principal, json.RawMessage) (any, error) {
		return map[string]any{"tables": []string{"log_app"}}, nil
	}}})
	s.options.Runtime = workerForTest(t)
	configure(t, server, provider)
	session := createSession(t, server)
	for i := 0; i < 2; i++ {
		status, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"查表"}`)
		if status != 200 || !strings.Contains(string(b), "turn.completed") {
			t.Fatalf("turn %d: %d %s", i, status, b)
		}
	}
	stored, err := s.getSession(context.Background(), Principal{ID: "alice"}, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Messages) != 6 || len(pendingTools(stored.Messages)) != 0 {
		t.Fatalf("invalid history: %+v", stored.Messages)
	}
	status, b := request(t, server.Client(), "GET", server.URL+"/api/v1/assistant/config", "")
	if status != 200 || !strings.Contains(string(b), `"runtime":"mastra"`) || !strings.Contains(string(b), `"max_input_tokens":32000`) {
		t.Fatalf("config: %s", b)
	}
	usage := false
	for _, e := range stored.Events {
		if e.Type == "turn.usage" && e.Data["total_tokens"] == float64(50) {
			usage = true
		}
	}
	if !usage {
		t.Fatal("reported usage not persisted")
	}
	if err := ValidateConfig(Config{BaseURL: provider.URL, Model: "f", MaxSteps: 13}); err == nil {
		t.Fatal("invalid step limit accepted")
	}
}

func TestActualMastraCompactionAndFailure(t *testing.T) {
	for _, failSummary := range []bool{false, true} {
		t.Run(fmt.Sprint(failSummary), func(t *testing.T) {
			var summaryCalls, executionCalls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["stream"] != true {
					summaryCalls.Add(1)
					if failSummary {
						w.WriteHeader(500)
						fmt.Fprint(w, "fixture-secret-provider-error")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"id":"summary","object":"chat.completion","created":1,"model":"fixture","choices":[{"index":0,"message":{"role":"assistant","content":"历史要求：检查 log_app，尚未保存大盘。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}`)
					return
				}
				executionCalls.Add(1)
				encoded, _ := json.Marshal(body)
				if !strings.Contains(string(encoded), "log_app") || strings.Contains(string(encoded), strings.Repeat("old", 50)) || !strings.Contains(string(encoded), "latest") {
					t.Error("summary/latest context missing or old history not compacted")
				}
				fixtureAnswer(w, "继续分析")
			}))
			defer provider.Close()
			input := RuntimeInput{System: "Monitoring", Config: Config{BaseURL: provider.URL + "/v1", Model: "fixture", MaxInputTokens: 4096, MaxOutputTokens: 256, MaxSteps: 2}, Tools: []RuntimeTool{}, Messages: []Message{{Role: "user", Content: strings.Repeat("old", 450)}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: strings.Repeat("old", 450)}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: "recent"}, {Role: "assistant", Content: "recent answer"}, {Role: "user", Content: "latest"}}}
			var compacted bool
			err := workerForTest(t).Run(context.Background(), input, nil, func(f RuntimeFrame) error {
				if f.Type == "compacted" {
					compacted = true
					if f.Through != 4 {
						t.Errorf("compaction boundary %d, want 4", f.Through)
					}
				}
				b, _ := json.Marshal(f)
				if strings.Contains(string(b), "fixture-secret") {
					t.Error("provider error leaked")
				}
				return nil
			})
			if failSummary {
				if err == nil || compacted || executionCalls.Load() != 0 {
					t.Fatalf("failed summary committed/executed: %v %v %d", err, compacted, executionCalls.Load())
				}
			} else if err != nil || !compacted || executionCalls.Load() != 1 {
				t.Fatalf("summary: %v %v %d", err, compacted, executionCalls.Load())
			}
			if summaryCalls.Load() == 0 {
				t.Fatal("did not summarize")
			}
		})
	}
}

func TestActualMastraProviderFailureAndStepLimit(t *testing.T) {
	for _, kind := range []string{"provider", "steps", "output"} {
		t.Run(kind, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if kind == "provider" {
					w.WriteHeader(401)
					fmt.Fprint(w, "fixture-secret")
					return
				}
				if kind == "steps" {
					fixtureTool(w, "list_tables")
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer provider.Close()
			input := RuntimeInput{System: "test", Config: Config{BaseURL: provider.URL, Model: "fixture", MaxInputTokens: 32000, MaxOutputTokens: 256, MaxSteps: 1}, Messages: []Message{{Role: "user", Content: "test"}}, Tools: []RuntimeTool{{Name: "list_tables", Schema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}}}
			err := workerForTest(t).Run(context.Background(), input, func(context.Context, string, json.RawMessage) (any, error) {
				return map[string]any{"tables": []string{}}, nil
			}, func(RuntimeFrame) error { return nil })
			if err == nil || strings.Contains(err.Error(), "fixture-secret") {
				t.Fatalf("expected sanitized failure: %v", err)
			}
		})
	}
}

func TestMastraUnknownToolAndMissingUsage(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			fixtureTool(w, "delete_everything")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"工具不可用\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer provider.Close()
	executed := 0
	failedReceipt := false
	reported := false
	err := workerForTest(t).Run(context.Background(), RuntimeInput{System: "test", Config: Config{BaseURL: provider.URL, Model: "fixture", MaxInputTokens: 32000, MaxOutputTokens: 256, MaxSteps: 3}, Messages: []Message{{Role: "user", Content: "test"}}, Tools: []RuntimeTool{}}, func(context.Context, string, json.RawMessage) (any, error) { executed++; return nil, nil }, func(f RuntimeFrame) error {
		if f.Name == "tool.result" && f.Data["status"] == "error" {
			failedReceipt = true
		}
		if f.Name == "turn.usage" {
			reported = true
		}
		return nil
	})
	if err != nil || executed != 0 || !failedReceipt || reported {
		t.Fatalf("unknown tool/usage: err=%v executed=%d failedReceipt=%v reported=%v", err, executed, failedReceipt, reported)
	}
}

func TestMastraChecksBudgetAfterToolResult(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); fixtureTool(w, "list_tables") }))
	defer provider.Close()
	input := RuntimeInput{System: "test", Config: Config{BaseURL: provider.URL, Model: "fixture", MaxInputTokens: 4096, MaxOutputTokens: 256, MaxSteps: 3}, Messages: []Message{{Role: "user", Content: "test"}}, Tools: []RuntimeTool{{Name: "list_tables", Schema: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}}}
	err := workerForTest(t).Run(context.Background(), input, func(context.Context, string, json.RawMessage) (any, error) {
		return map[string]any{"table": strings.Repeat("x", 5000)}, nil
	}, func(RuntimeFrame) error { return nil })
	if err == nil || !strings.Contains(err.Error(), "budget") || requests.Load() != 1 {
		t.Fatalf("oversize tool prompt sent: %v requests=%d", err, requests.Load())
	}
}

func TestMastraFailedSummaryPreservesStoredHistory(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); fmt.Fprint(w, "fixture-secret") }))
	defer provider.Close()
	s, server := fixtureService(t, nil)
	s.options.Runtime = workerForTest(t)
	c := Config{BaseURL: provider.URL, Model: "fixture", Enabled: true, MaxInputTokens: 8192, MaxOutputTokens: 256, MaxSteps: 2}
	b, _ := json.Marshal(c)
	status, response := request(t, server.Client(), "PUT", server.URL+"/api/v1/assistant/config", string(b))
	if status != 200 {
		t.Fatalf("config: %s", response)
	}
	session := createSession(t, server)
	session.Messages = []Message{{Role: "user", Content: strings.Repeat("x", 3000)}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: strings.Repeat("y", 3000)}, {Role: "assistant", Content: "old answer"}}
	if err := s.saveSession(context.Background(), Principal{ID: "alice"}, &session); err != nil {
		t.Fatal(err)
	}
	_, response = request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"继续"}`)
	if !strings.Contains(string(response), "turn.failed") {
		t.Fatalf("expected summary failure: %s", response)
	}
	stored, err := s.getSession(context.Background(), Principal{ID: "alice"}, session.ID)
	if err != nil || stored.SummaryThrough != 0 || stored.Summary != "" || len(stored.Messages) != 5 || stored.Messages[0].Content != session.Messages[0].Content {
		t.Fatalf("source history changed: %v %+v", err, stored)
	}
}

func TestMastraCancelReleasesInstanceAndSessionSlots(t *testing.T) {
	started := make(chan struct{}, 1)
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if requests.Add(1) > 1 {
			fixtureAnswer(w, "继续成功")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer provider.Close()
	s, server := fixtureService(t, nil)
	s.options.Runtime = workerForTest(t)
	s.options.MaxConcurrentTurns = 1
	configure(t, server, provider)
	first := createSession(t, server)
	second := createSession(t, server)
	done := make(chan []byte, 1)
	go func() {
		_, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+first.ID+"/turns", `{"text":"wait"}`)
		done <- b
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start")
	}
	status, _ := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+second.ID+"/turns", `{"text":"concurrent"}`)
	if status != 429 {
		t.Fatalf("instance limit not enforced: %d", status)
	}
	_, _ = request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+first.ID+"/cancel", `{}`)
	select {
	case b := <-done:
		if !strings.Contains(string(b), "turn.cancelled") {
			t.Fatalf("cancel: %s", b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel did not complete")
	}
	status, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+first.ID+"/turns", `{"text":"continue"}`)
	if status != 200 || !strings.Contains(string(b), "turn.completed") {
		t.Fatalf("slot not released: %d %s", status, b)
	}
	stored, _ := s.getSession(context.Background(), Principal{ID: "alice"}, second.ID)
	if len(stored.Messages) != 0 {
		t.Fatal("busy turn changed session")
	}
}

func TestMastraMonitoringQueryAndDraftReceipts(t *testing.T) {
	names := []string{"list_tables", "describe_table", "run_query", "draft_dashboard"}
	inputs := []string{`{}`, `{"table":"log_app"}`, `{"sql":"SELECT count() FROM log_app WHERE $__timeFilter(event_time)","range":{"from":"2026-10-14T00:00:00Z","to":"2026-10-14T01:00:00Z"},"interval_ms":60000}`, `{"title":"日志总量","panels":[{"title":"日志总量","type":"stat","queries":[{"refId":"A","sql":"SELECT count() FROM log_app WHERE $__timeFilter(event_time)"}]}]}`}
	var requests atomic.Int32
	var queries atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(requests.Add(1)) - 1
		if n >= len(names) {
			fixtureAnswer(w, "查询了日志总量，并生成尚未保存的大盘草稿。")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		payload := map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": fmt.Sprintf("call-%d", n), "type": "function", "function": map[string]any{"name": names[n], "arguments": inputs[n]}}}}, "finish_reason": "tool_calls"}}}
		encoded, _ := json.Marshal(payload)
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	defer provider.Close()
	tools := monitoringTools(shared.Dependencies{Catalog: func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "app", Name: "log_app", Kind: "log", Columns: []shared.Column{{Name: "event_time", Type: "DateTime64"}}}}, nil
	}, Query: func(ctx context.Context, q shared.QueryRequest) (shared.QueryResponse, error) {
		queries.Add(1)
		if q.Source != "assistant" || q.Range.From != "2026-10-14T00:00:00Z" || len(q.Queries) != 1 {
			t.Error("wrong host query scope")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("query not bounded")
		}
		return shared.QueryResponse{Results: []shared.QueryResult{{RefID: "A", Status: "success", Frames: []shared.Frame{{Columns: []shared.Column{{Name: "count", Type: "UInt64"}}, Rows: [][]any{{"17"}}}}}}}, nil
	}})
	s, server := fixtureService(t, tools)
	s.options.Runtime = workerForTest(t)
	configure(t, server, provider)
	session := createSession(t, server)
	status, b := request(t, server.Client(), "POST", server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"读取表结构，查询日志并生成大盘草稿"}`)
	if status != 200 || !strings.Contains(string(b), "turn.completed") || queries.Load() != 1 {
		t.Fatalf("monitoring scenario: %d %s query=%d", status, b, queries.Load())
	}
	stored, _ := s.getSession(context.Background(), Principal{ID: "alice"}, session.ID)
	if len(stored.Messages) != 10 || len(pendingTools(stored.Messages)) != 0 {
		t.Fatalf("incomplete history: %+v", stored.Messages)
	}
	draft, query := false, false
	for _, e := range stored.Events {
		if e.Type != "tool.result" {
			continue
		}
		value, ok := e.Data["value"].(map[string]any)
		if !ok {
			continue
		}
		if e.Data["tool"] == "draft_dashboard" {
			draft = value["saved"] == false && value["requires_review"] == true
		}
		if e.Data["tool"] == "run_query" {
			query = value["sample_limit"] == float64(1000) && e.Data["status"] == "success"
		}
	}
	if !draft || !query {
		t.Fatalf("draft/query receipts missing: draft=%v query=%v", draft, query)
	}
}

func TestMastraCancellationDuringSummaryDoesNotCommitPrefix(t *testing.T) {
	started := make(chan struct{}, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer provider.Close()
	worker := workerForTest(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	var compacted atomic.Bool
	input := RuntimeInput{System: "Monitoring", Config: Config{BaseURL: provider.URL, Model: "fixture", MaxInputTokens: 4096, MaxOutputTokens: 256, MaxSteps: 2}, Tools: []RuntimeTool{}, Messages: []Message{{Role: "user", Content: strings.Repeat("old", 450)}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: strings.Repeat("old", 450)}, {Role: "assistant", Content: "old answer"}, {Role: "user", Content: "recent"}, {Role: "assistant", Content: "recent answer"}, {Role: "user", Content: "latest"}}}
	go func() {
		done <- worker.Run(ctx, input, nil, func(f RuntimeFrame) error {
			if f.Type == "compacted" {
				compacted.Store(true)
			}
			return nil
		})
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("summary request never started")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || compacted.Load() {
			t.Fatalf("cancelled summary committed: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("summary did not cancel")
	}
}
