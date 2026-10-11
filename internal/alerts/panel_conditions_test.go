package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestChartGroupsOverrideTableRoutes(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	ctx := context.Background()
	r.GroupIDs = []string{"group-b"}
	routes, warnings, err := m.route(ctx, r)
	if err != nil || len(warnings) != 0 || len(routes) != 1 || encode(routes[0].GroupIDs) != `["group-b"]` {
		t.Fatalf("routes=%+v warnings=%v err=%v", routes, warnings, err)
	}
	r.GroupIDs = []string{"group-a", "group-b"}
	routes, _, err = m.route(ctx, r)
	if err != nil || len(routes) != 1 || len(routes[0].GroupIDs) != 2 {
		t.Fatalf("targets must be deduplicated: %+v %v", routes, err)
	}
	m.deps.Catalog = func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "metric_http_sum", Name: "metric_http_sum"}}, nil
	}
	r.GroupIDs = []string{"group-b"}
	r.PanelCondition = &PanelCondition{PanelID: "panel", QueryRef: "A", Reducer: "last"}
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	routes, warnings, err = m.route(ctx, r)
	if err != nil || len(warnings) != 0 || len(routes) != 1 {
		t.Fatalf("chart must work without a table group: %+v %v %v", routes, warnings, err)
	}
	raw := request(t, mux, "GET", "/api/v1/alerts/rules?group_id=group-b", nil, 200)
	var filtered []Rule
	json.Unmarshal(raw, &filtered)
	if len(filtered) != 1 || filtered[0].PanelCondition.PanelID != "panel" {
		t.Fatalf("direct group not listed: %s", raw)
	}
	raw = request(t, mux, "GET", "/api/v1/alerts/tables?group_id=group-b", nil, 200)
	var overview []struct {
		Configured bool   `json:"configured"`
		Warning    string `json:"warning"`
	}
	json.Unmarshal(raw, &overview)
	if len(overview) != 1 || !overview[0].Configured || overview[0].Warning != "" {
		t.Fatalf("direct chart groups must configure the overview without table binding: %s", raw)
	}
	request(t, mux, "DELETE", "/api/v1/alerts/groups/group-b", nil, 409)
	r.GroupIDs = []string{"missing"}
	request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 400)
	r.GroupIDs = []string{"group-b", "group-b"}
	request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 400)
}

func TestChartNoDataFiresAndRecoversPerLine(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	r.Operator, r.Threshold, r.ForSeconds, r.NotifyHealth = "no_data", "0", 0, false
	r.SQL = "SELECT service, count() AS value FROM metric_http_sum GROUP BY service"
	r.LabelFields = []string{"service"}
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	rows := [][]any{{"a", "3"}, {"b", "2"}}
	failed := false
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		if failed {
			return shared.QueryResponse{}, errors.New("query unavailable")
		}
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "service", Type: "String"}, {Name: "value", Type: "UInt64"}}, Rows: rows}}}}}, nil
	}
	now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	evaluate := func() {
		t.Helper()
		if err := m.Evaluate(context.Background(), r, now); err != nil {
			t.Fatal(err)
		}
		now = now.Add(10 * time.Second)
	}
	evaluate()
	rows = [][]any{{"a", "0"}, {"b", "2"}}
	evaluate()
	events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events ORDER BY created_at")
	if len(events) != 1 || events[0].Kind != "firing" || events[0].State.Labels["service"] != "a" {
		t.Fatalf("zero points: %+v", events)
	}
	rows = [][]any{{"a", "1"}}
	evaluate()
	events, _ = listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events ORDER BY created_at")
	if len(events) != 3 {
		t.Fatalf("one recovered and one missing: %+v", events)
	}
	rows = nil
	evaluate()
	states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	if len(states) != 2 {
		t.Fatalf("empty query invented an extra line: %+v", states)
	}
	for _, state := range states {
		if state.Status != "firing" || state.Health != "ok" {
			t.Fatalf("missing line: %+v", state)
		}
	}
	before, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events")
	failed = true
	evaluate()
	after, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events")
	if len(after) != len(before) {
		t.Fatalf("query failure must not trigger or resolve no-data: %+v", after)
	}
	failed = false
	rows = [][]any{{"a", "1"}, {"b", "1"}}
	evaluate()
	states, _ = listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	for _, state := range states {
		if state.Status != "normal" || state.Episode != "" {
			t.Fatalf("data did not recover: %+v", state)
		}
	}
}

func TestChartNoDataWaitAndPreview(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	r.Operator, r.Threshold, r.ForSeconds, r.NotifyHealth = "no_data", "0", 20, false
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "empty", Complete: true}}}, nil
	}
	now := time.Now().UTC()
	p, err := m.inspect(context.Background(), r, now)
	if err != nil || len(p.States) != 1 || p.States[0].Status != "firing" {
		t.Fatalf("preview=%+v err=%v", p, err)
	}
	for _, offset := range []time.Duration{0, 10 * time.Second, 21 * time.Second} {
		if err = m.Evaluate(context.Background(), r, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events")
	if len(events) != 1 || events[0].Kind != "firing" {
		t.Fatalf("duration/deduplication: %+v", events)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/alerts/annotations?rule_id="+r.ID+"&from="+stamp(now.Add(-time.Minute))+"&to="+stamp(now.Add(time.Minute)), nil))
	if w.Code != 200 {
		t.Fatalf("annotations: %s", w.Body.String())
	}
	var result struct {
		Events []Event `json:"events"`
	}
	json.Unmarshal(w.Body.Bytes(), &result)
	if len(result.Events) != 1 {
		t.Fatalf("no-data event annotation missing: %s", w.Body.String())
	}
}

func TestChartNoDataInitialAbsenceRetiresWhenLinesAppear(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	r.Operator, r.Threshold, r.ForSeconds, r.NotifyHealth = "no_data", "0", 0, false
	r.LabelFields = []string{"service"}
	r.SQL = "SELECT service, count() AS value FROM metric_http_sum GROUP BY service"
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	var rows [][]any
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "service", Type: "String"}, {Name: "value", Type: "UInt64"}}, Rows: rows}}}}}, nil
	}
	now := time.Now().UTC()
	if err := m.Evaluate(context.Background(), r, now); err != nil {
		t.Fatal(err)
	}
	rows = [][]any{{"a", "1"}, {"b", "1"}}
	if err := m.Evaluate(context.Background(), r, now.Add(10*time.Second)); err != nil {
		t.Fatal(err)
	}
	states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	if len(states) != 2 {
		t.Fatalf("initial absence must not become a permanently missing third line: %+v", states)
	}
	events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events ORDER BY created_at")
	if len(events) != 2 || events[0].Kind != "firing" || events[1].Kind != "resolved" {
		t.Fatalf("initial whole-query recovery: %+v", events)
	}
}
