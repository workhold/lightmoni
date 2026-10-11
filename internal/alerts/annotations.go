package alerts

import (
	"github.com/lightmoni/lightmoni/internal/shared"
	"net/http"
	"strings"
	"time"
)

// Query the selected time window before limiting, so older dashboard ranges do
// not silently lose their annotations behind the most recent global events.
func (m *Module) annotations(w http.ResponseWriter, r *http.Request) {
	from, e1 := time.Parse(time.RFC3339Nano, r.URL.Query().Get("from"))
	to, e2 := time.Parse(time.RFC3339Nano, r.URL.Query().Get("to"))
	ids := r.URL.Query()["rule_id"]
	panelID := r.URL.Query().Get("panel_id")
	if e1 != nil || e2 != nil || !from.Before(to) || (len(ids) == 0 && panelID == "") || len(ids) > 16 || len(panelID) > 128 {
		shared.Error(w, 400, "请选择有效时间范围、图表或 1–16 条告警规则")
		return
	}
	placeholders := []string{}
	ruleArgs := []any{}
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || len(id) > 128 {
			shared.Error(w, 400, "告警规则 ID 无效")
			return
		}
		if !seen[id] {
			seen[id] = true
			placeholders = append(placeholders, "?")
			ruleArgs = append(ruleArgs, id)
		}
	}
	conditions := []string{}
	if len(placeholders) > 0 {
		conditions = append(conditions, "id IN ("+strings.Join(placeholders, ",")+")")
	}
	if panelID != "" {
		// Saving an alert takes effect before the dashboard's panel binding is saved.
		conditions = append(conditions, "json_extract(body,'$.panel_condition.panel_id')=?")
		ruleArgs = append(ruleArgs, panelID)
	}
	rules, err := listBodies[Rule](r.Context(), m.deps.DB, "SELECT body FROM alert_rules WHERE "+strings.Join(conditions, " OR ")+" ORDER BY rowid", ruleArgs...)
	if err != nil {
		respond(w, nil, err)
		return
	}
	args := append([]any{stamp(from), stamp(to)}, ruleArgs[:len(placeholders)]...)
	for _, rule := range rules {
		if !seen[rule.ID] {
			seen[rule.ID] = true
			placeholders = append(placeholders, "?")
			args = append(args, rule.ID)
		}
	}
	if len(placeholders) == 0 {
		shared.JSON(w, 200, map[string]any{"events": []Event{}, "rules": rules, "truncated": false})
		return
	}
	events, err := listBodies[Event](r.Context(), m.deps.DB, `SELECT body FROM alert_events WHERE created_at>=? AND created_at<=? AND rule_id IN (`+strings.Join(placeholders, ",")+`) AND json_extract(body,'$.kind') IN ('firing','resolved') ORDER BY created_at LIMIT 501`, args...)
	if err != nil {
		respond(w, nil, err)
		return
	}
	truncated := len(events) > 500
	if truncated {
		events = events[:500]
	}
	shared.JSON(w, 200, map[string]any{"events": events, "rules": rules, "truncated": truncated})
}
