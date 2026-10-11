package alerts

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestAnnotationsDiscoverPanelAlertsBeforeDashboardBindingIsSaved(t *testing.T) {
	m, mux := testModule(t)
	when := time.Date(2026, 10, 1, 0, 1, 0, 0, time.UTC)
	for _, id := range []string{"owned", "linked", "unrelated"} {
		panelID := "other"
		if id == "owned" {
			panelID = "panel"
		}
		rule := Rule{ID: id, Threshold: "80", PanelCondition: &PanelCondition{PanelID: panelID, QueryRef: "A", Reducer: "last"}}
		if _, err := m.deps.DB.Exec("INSERT INTO alert_rules(id,body) VALUES(?,?)", id, encode(rule)); err != nil {
			t.Fatal(err)
		}
		event := Event{ID: id, RuleID: id, Kind: "firing", CreatedAt: stamp(when), State: State{Value: "95"}}
		if _, err := m.deps.DB.Exec("INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)", id, id, event.CreatedAt, encode(event)); err != nil {
			t.Fatal(err)
		}
	}
	var out struct {
		Rules  []Rule  `json:"rules"`
		Events []Event `json:"events"`
	}
	window := "&from=2026-10-01T00:00:00Z&to=2026-10-01T01:00:00Z"
	read := func(scope string) {
		t.Helper()
		raw := request(t, mux, "GET", "/api/v1/alerts/annotations?"+scope+window, nil, 200)
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
	}
	read("panel_id=panel")
	if len(out.Rules) != 1 || out.Rules[0].ID != "owned" || len(out.Events) != 1 || out.Events[0].RuleID != "owned" {
		t.Fatalf("panel scope: %+v", out)
	}
	read("panel_id=panel&rule_id=linked&rule_id=linked&rule_id=owned")
	if len(out.Rules) != 2 || len(out.Events) != 2 {
		t.Fatalf("merged/deduplicated scope: %+v", out)
	}
	read("panel_id=empty")
	if out.Rules == nil || out.Events == nil || len(out.Rules) != 0 || len(out.Events) != 0 {
		t.Fatalf("empty panel: %+v", out)
	}
	request(t, mux, "GET", "/api/v1/alerts/annotations?panel_id="+strings.Repeat("x", 129)+window, nil, 400)
}

func TestAnnotationsSelectWindowBeforeLimitAndKeepRuleScope(t *testing.T) {
	m, mux := testModule(t)
	tx, err := m.deps.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	add := func(id, rule, kind string, when time.Time) {
		event := Event{ID: id, RuleID: rule, RuleName: rule, Kind: kind, CreatedAt: stamp(when), State: State{Value: "12"}}
		if _, err = tx.Exec("INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)", id, rule, event.CreatedAt, encode(event)); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	add("old-fired", "a", "firing", start.Add(time.Minute))
	add("old-recovered", "a", "resolved", start.Add(2*time.Minute))
	add("old-pending", "a", "pending", start.Add(3*time.Minute))
	add("other-rule", "b", "firing", start.Add(time.Minute))
	for i := 0; i < 1001; i++ {
		add(fmt.Sprint(i), "a", "firing", start.Add(24*time.Hour+time.Duration(i)*time.Second))
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var out struct {
		Events    []Event `json:"events"`
		Truncated bool    `json:"truncated"`
	}
	raw := request(t, mux, "GET", "/api/v1/alerts/annotations?rule_id=a&from=2026-10-01T00:00:00Z&to=2026-10-01T01:00:00Z", nil, 200)
	if err = json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Events) != 2 || out.Truncated || out.Events[0].ID != "old-fired" || out.Events[1].ID != "old-recovered" {
		t.Fatalf("window/scope: %s", raw)
	}
	raw = request(t, mux, "GET", "/api/v1/alerts/annotations?rule_id=a&from=2026-10-02T00:00:00Z&to=2026-10-03T00:00:00Z", nil, 200)
	_ = json.Unmarshal(raw, &out)
	if len(out.Events) != 500 || !out.Truncated {
		t.Fatalf("limit: count=%d truncated=%v", len(out.Events), out.Truncated)
	}
	request(t, mux, "GET", "/api/v1/alerts/annotations?rule_id=a&from=invalid&to=2026-10-01T01:00:00Z", nil, 400)
}

func TestLogAndSQLRulesUseTheSameValidatedEvaluator(t *testing.T) {
	_, mux := testModule(t)
	for _, kind := range []string{"log", "sql"} {
		rule := Rule{Unit: "short", Name: kind + " condition", Kind: kind, Enabled: true, SQL: "SELECT count() AS value FROM log_app WHERE $__timeFilter(event_time)", SourceTableIDs: []string{"log_app"}, ValueField: "value", Operator: "gt", Threshold: "10", IntervalSeconds: 60, WindowSeconds: 300}
		raw := request(t, mux, "POST", "/api/v1/alerts/rules", rule, 200)
		var saved Rule
		_ = json.Unmarshal(raw, &saved)
		if saved.Kind != kind || saved.Unit != "short" {
			t.Fatalf("kind not saved: %s", raw)
		}
		raw = request(t, mux, "POST", "/api/v1/alerts/preview", saved, 200)
		var preview Preview
		_ = json.Unmarshal(raw, &preview)
		if len(preview.States) != 1 || preview.States[0].Value != "100" || preview.States[0].Status != "firing" {
			t.Fatalf("preview: %s", raw)
		}
	}
	request(t, mux, "POST", "/api/v1/alerts/rules", Rule{Kind: "unknown"}, 400)
	request(t, mux, "POST", "/api/v1/alerts/rules", Rule{}, 400)
}
