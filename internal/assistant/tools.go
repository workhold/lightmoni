package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func schema(value string) json.RawMessage { return json.RawMessage(value) }
func parseInput(raw json.RawMessage, target any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	d.UseNumber()
	if err := d.Decode(target); err != nil {
		return fmt.Errorf("invalid tool input: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("tool input must contain one JSON object")
	}
	return nil
}

// DashboardDraft matches the dashboard author's normal JSON form. It is a
// proposal only: this module never has a save-dashboard tool.
type DashboardDraft struct {
	Title       string       `json:"title"`
	Description string       `json:"description,omitempty"`
	Panels      []DraftPanel `json:"panels"`
}
type DraftPanel struct {
	ID      string         `json:"id,omitempty"`
	Title   string         `json:"title"`
	Type    string         `json:"type"`
	Queries []shared.Query `json:"queries"`
	Options map[string]any `json:"options,omitempty"`
	Grid    map[string]int `json:"grid,omitempty"`
}

func monitoringTools(deps shared.Dependencies) []Tool {
	return []Tool{
		{Name: "list_tables", Description: "List available LightMoni telemetry tables, their kinds and services. Use this before constructing SQL.", Effect: "read", InputSchema: schema(`{"type":"object","properties":{},"additionalProperties":false}`), Execute: func(ctx context.Context, _ Principal, input json.RawMessage) (any, error) {
			var request struct{}
			if err := parseInput(input, &request); err != nil {
				return nil, err
			}
			if deps.Catalog == nil {
				return nil, errors.New("table catalog is unavailable")
			}
			tables, err := deps.Catalog(ctx)
			if err != nil {
				return nil, errors.New("cannot read table catalog")
			}
			if len(tables) > 200 {
				tables = tables[:200]
			}
			return map[string]any{"tables": tables, "limit": 200}, nil
		}},
		{Name: "describe_table", Description: "Read the columns and services of one known telemetry table. Accepts the table name or stable id.", Effect: "read", InputSchema: schema(`{"type":"object","properties":{"table":{"type":"string"}},"required":["table"],"additionalProperties":false}`), Execute: func(ctx context.Context, _ Principal, input json.RawMessage) (any, error) {
			var request struct {
				Table string `json:"table"`
			}
			if err := parseInput(input, &request); err != nil {
				return nil, err
			}
			if deps.Catalog == nil {
				return nil, errors.New("table catalog is unavailable")
			}
			tables, err := deps.Catalog(ctx)
			if err != nil {
				return nil, errors.New("cannot read table catalog")
			}
			for _, table := range tables {
				if table.ID == request.Table || table.Name == request.Table {
					return table, nil
				}
			}
			return nil, errors.New("table does not exist in the catalog")
		}},
		{Name: "run_query", Description: "Execute one bounded read-only ClickHouse query. Include $__timeFilter(event_time) and supply an explicit UTC half-open time range. Up to 1000 result rows are shown to the assistant; truncation is explicit.", Effect: "read", InputSchema: schema(`{"type":"object","properties":{"sql":{"type":"string"},"range":{"type":"object","properties":{"from":{"type":"string"},"to":{"type":"string"}},"required":["from","to"],"additionalProperties":false},"interval_ms":{"type":"integer","minimum":1},"params":{"type":"object"}},"required":["sql","range","interval_ms"],"additionalProperties":false}`), Execute: func(ctx context.Context, _ Principal, input json.RawMessage) (any, error) {
			var request struct {
				SQL        string                      `json:"sql"`
				Range      shared.Range                `json:"range"`
				IntervalMS int64                       `json:"interval_ms"`
				Params     map[string]shared.Parameter `json:"params"`
			}
			if err := parseInput(input, &request); err != nil {
				return nil, err
			}
			if len(request.SQL) > 16000 || strings.TrimSpace(request.SQL) == "" || request.IntervalMS <= 0 {
				return nil, errors.New("SQL and a positive interval_ms are required")
			}
			from, e1 := time.Parse(time.RFC3339Nano, request.Range.From)
			to, e2 := time.Parse(time.RFC3339Nano, request.Range.To)
			if e1 != nil || e2 != nil || !from.Before(to) || to.Sub(from) > 90*24*time.Hour {
				return nil, errors.New("query range must be a valid increasing UTC range within 90 days")
			}
			if deps.Query == nil {
				return nil, errors.New("query executor is unavailable")
			}
			queryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			response, err := deps.Query(queryCtx, shared.QueryRequest{RequestID: randomID(), Range: request.Range, IntervalMS: request.IntervalMS, Source: "assistant", Queries: []shared.Query{{RefID: "A", SQL: request.SQL, Params: request.Params}}})
			if err != nil {
				return nil, err
			}
			if len(response.Results) != 1 {
				return nil, errors.New("query executor returned an unexpected result count")
			}
			for _, result := range response.Results {
				if result.Status == "error" || result.Status == "cancelled" {
					message := result.Error
					if message == "" {
						message = "query did not complete successfully"
					}
					return nil, errors.New(message)
				}
			}
			remaining := 1000
			sampled := false
			for i := range response.Results {
				for j := range response.Results[i].Frames {
					rows := response.Results[i].Frames[j].Rows
					if len(rows) > remaining {
						response.Results[i].Frames[j].Rows = rows[:remaining]
						sampled = true
					}
					remaining -= len(response.Results[i].Frames[j].Rows)
				}
			}
			return map[string]any{"query": response, "range": request.Range, "sample_limit": 1000, "sample_truncated": sampled}, nil
		}},
		{Name: "draft_dashboard", Description: "Propose a reviewable dashboard draft. This tool does NOT save it. Include concrete queries over verified tables; users will preview and explicitly save through the dashboard editor.", Effect: "draft", InputSchema: schema(`{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"panels":{"type":"array","maxItems":12,"items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"type":{"type":"string","enum":["timeseries","bar","pie","stat","table","heatmap","gauge"]},"queries":{"type":"array","items":{"type":"object","properties":{"refId":{"type":"string"},"sql":{"type":"string"},"params":{"type":"object"}},"required":["refId","sql"],"additionalProperties":false}},"options":{"type":"object"},"grid":{"type":"object"}},"required":["title","type","queries"],"additionalProperties":false}}},"required":["title","panels"],"additionalProperties":false}`), Execute: func(_ context.Context, _ Principal, input json.RawMessage) (any, error) {
			var draft DashboardDraft
			if err := parseInput(input, &draft); err != nil {
				return nil, err
			}
			if strings.TrimSpace(draft.Title) == "" || len(draft.Title) > 200 || len(draft.Description) > 2000 || len(draft.Panels) == 0 || len(draft.Panels) > 12 {
				return nil, errors.New("draft requires a title and 1 to 12 panels")
			}
			allowed := map[string]bool{"timeseries": true, "bar": true, "pie": true, "stat": true, "table": true, "heatmap": true, "gauge": true}
			for i := range draft.Panels {
				panel := &draft.Panels[i]
				if !allowed[panel.Type] || strings.TrimSpace(panel.Title) == "" || len(panel.Queries) == 0 || len(panel.Queries) > 8 {
					return nil, errors.New("every panel needs a supported visualization, title and queries")
				}
				for _, query := range panel.Queries {
					if query.RefID == "" || strings.TrimSpace(query.SQL) == "" || len(query.SQL) > 16000 {
						return nil, errors.New("every draft query requires refId and SQL")
					}
				}
				if panel.ID == "" {
					panel.ID = randomID()
				}
			}
			return map[string]any{"draft": draft, "saved": false, "requires_review": true}, nil
		}},
	}
}
