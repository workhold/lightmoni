package assistant

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestMonitoringToolsUseSharedQueryAndExplicitSampleLimit(t *testing.T) {
	var received shared.QueryRequest
	tables := []shared.Table{{ID: "table-1", Name: "log_app", Kind: "log", Services: []string{"api"}, Columns: []shared.Column{{Name: "event_time", Type: "DateTime64"}, {Name: "body", Type: "String"}}}}
	tools := monitoringTools(shared.Dependencies{Catalog: func(context.Context) ([]shared.Table, error) { return tables, nil }, Query: func(_ context.Context, request shared.QueryRequest) (shared.QueryResponse, error) {
		received = request
		rows := make([][]any, 1005)
		for i := range rows {
			rows[i] = []any{"18446744073709551615"}
		}
		return shared.QueryResponse{Results: []shared.QueryResult{{RefID: "A", Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "counter", Type: "UInt64"}}, Rows: rows}}}}}, nil
	}})
	input := json.RawMessage(`{"sql":"SELECT body FROM log_app WHERE $__timeFilter(event_time)","range":{"from":"2026-10-10T00:00:00Z","to":"2026-10-10T01:00:00Z"},"interval_ms":60000}`)
	value, err := tools[2].Execute(context.Background(), Principal{ID: "alice"}, input)
	if err != nil {
		t.Fatal(err)
	}
	if received.Source != "assistant" || len(received.Queries) != 1 || received.Queries[0].RefID != "A" || received.Range.From != "2026-10-10T00:00:00Z" {
		t.Fatalf("did not use shared bounded query: %+v", received)
	}
	result := value.(map[string]any)
	response := result["query"].(shared.QueryResponse)
	if !result["sample_truncated"].(bool) || len(response.Results[0].Frames[0].Rows) != 1000 || response.Results[0].Frames[0].Rows[0][0] != "18446744073709551615" {
		t.Fatal("sample bound or exact integer value was lost")
	}
	if _, err := tools[1].Execute(context.Background(), Principal{}, json.RawMessage(`{"table":"system.secrets"}`)); err == nil {
		t.Fatal("unknown table was exposed")
	}
	if _, err := tools[2].Execute(context.Background(), Principal{}, json.RawMessage(`{"sql":"SELECT 1","range":{"from":"bad","to":"bad"},"interval_ms":1}`)); err == nil {
		t.Fatal("invalid time range accepted")
	}
}

func TestDashboardToolOnlyProducesReviewableDraft(t *testing.T) {
	tools := monitoringTools(shared.Dependencies{})
	input := json.RawMessage(`{"title":"API 请求","panels":[{"title":"请求量","type":"timeseries","queries":[{"refId":"A","sql":"SELECT $__timeInterval(event_time), sum(value) FROM metric_http_sum WHERE $__timeFilter(event_time) GROUP BY 1"}]}]}`)
	value, err := tools[3].Execute(context.Background(), Principal{}, input)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(map[string]any)
	draft := result["draft"].(DashboardDraft)
	if result["saved"] != false || result["requires_review"] != true || len(draft.Panels) != 1 || draft.Panels[0].ID == "" {
		t.Fatal("tool claimed save or omitted reviewable draft")
	}
	if _, err := tools[3].Execute(context.Background(), Principal{}, json.RawMessage(`{"title":"unsafe","panels":[],"save":true}`)); err == nil {
		t.Fatal("unknown write flag accepted")
	}
}

func TestPendingToolHistoryCanBeClosedAfterCancellation(t *testing.T) {
	first := ToolCall{ID: "call-1", Function: FunctionCall{Name: "list_tables"}}
	second := ToolCall{ID: "call-2", Function: FunctionCall{Name: "run_query"}}
	messages := []Message{{Role: "assistant", ToolCalls: []ToolCall{first, second}}, {Role: "tool", ToolCallID: "call-1", Content: "{}"}}
	pending := pendingTools(messages)
	if len(pending) != 1 || pending[0].ID != "call-2" {
		t.Fatal("unresolved tool call was not identified")
	}
}

func TestQueryResultFailureIsNotPresentedAsSuccessfulTool(t *testing.T) {
	tools := monitoringTools(shared.Dependencies{Query: func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{RefID: "A", Status: "error", Error: "read-only SELECT required"}}}, nil
	}})
	_, err := tools[2].Execute(context.Background(), Principal{}, json.RawMessage(`{"sql":"DELETE FROM log_app","range":{"from":"2026-10-10T00:00:00Z","to":"2026-10-10T01:00:00Z"},"interval_ms":60000}`))
	if err == nil || err.Error() != "read-only SELECT required" {
		t.Fatalf("SQL failure was presented as success: %v", err)
	}
}
