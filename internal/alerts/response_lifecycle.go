package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
)

func (m *Module) cancelResponseTx(tx *sql.Tx, r IncidentResponse, reason string) error {
	r.State = "cancelled"
	r.Generation++
	r.DeferredReason = reason
	r.ResolutionNotified = true
	if e := saveResponse(tx, r); e != nil {
		return e
	}
	if e := auditResponse(tx, r, "cancelled", "", "", reason, m.now()); e != nil {
		return e
	}
	if _, e := tx.Exec("UPDATE alert_assignments SET outcome='cancelled' WHERE response_id=? AND outcome='pending'", r.ID); e != nil {
		return e
	}
	_, e := tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", r.ID)
	return e
}

// The caller holds m.mu. Reconcile bindings even when rule reminders are disabled.
func (m *Module) syncResponseRoutes(ctx context.Context) error {
	states, e := listBodies[State](ctx, m.deps.DB, "SELECT body FROM alert_states WHERE coalesce(json_extract(body,'$.episode'),'')<>'' OR coalesce(json_extract(body,'$.health_episode'),'')<>''")
	if e != nil {
		return e
	}
	type entry struct {
		event  Event
		rule   Rule
		groups []Group
	}
	entries := []entry{}
	ruleCache := map[string]Rule{}
	groupsCache := map[string][]Group{}
	for _, state := range states {
		rule, ok := ruleCache[state.RuleID]
		if !ok {
			var raw string
			if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", state.RuleID).Scan(&raw) != nil {
				continue
			}
			if json.Unmarshal([]byte(raw), &rule) != nil {
				continue
			}
			ruleCache[rule.ID] = rule
			groupsCache[rule.ID], e = m.ruleResponseGroups(ctx, rule)
			if e != nil {
				return e
			}
		}
		if !rule.Enabled {
			continue
		}
		for _, episode := range []string{state.Episode, state.HealthEpisode} {
			if episode == "" {
				continue
			}
			var raw string
			if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_events WHERE rule_id=? AND json_extract(body,'$.episode')=? ORDER BY created_at,rowid LIMIT 1", rule.ID, episode).Scan(&raw) != nil {
				continue
			}
			var event Event
			if json.Unmarshal([]byte(raw), &event) != nil {
				continue
			}
			event.State = state
			if episode == state.Episode {
				event.Kind = "firing"
			} else {
				event.Kind = state.Health
			}
			entries = append(entries, entry{event, rule, groupsCache[rule.ID]})
		}
	}
	if len(entries) == 0 {
		return nil
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for _, entry := range entries {
		ids := []string{}
		for _, g := range entry.groups {
			if len(g.Members) > 0 {
				ids = append(ids, g.ID)
			}
		}
		rows, e := tx.Query("SELECT body FROM alert_responses WHERE episode=? AND state NOT IN ('resolved','cancelled')", entry.event.Episode)
		if e != nil {
			return e
		}
		existing := []IncidentResponse{}
		for rows.Next() {
			var raw string
			if e = rows.Scan(&raw); e != nil {
				rows.Close()
				return e
			}
			var r IncidentResponse
			_ = json.Unmarshal([]byte(raw), &r)
			existing = append(existing, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, r := range existing {
			if !includes(ids, r.GroupID) {
				if e = m.cancelResponseTx(tx, r, "责任组路由已变更"); e != nil {
					return e
				}
			}
		}
		for _, g := range entry.groups {
			if len(g.Members) == 0 {
				continue
			}
			var raw string
			if tx.QueryRow("SELECT body FROM alert_responses WHERE episode=? AND group_id=?", entry.event.Episode, g.ID).Scan(&raw) == nil {
				var old IncidentResponse
				_ = json.Unmarshal([]byte(raw), &old)
				if old.State == "cancelled" && (old.DeferredReason == "责任组路由已变更" || old.DeferredReason == "规则已禁用") {
					old.State = "unclaimed"
					old.Group = g
					if old.OwnerID != "" && includes(g.Members, old.OwnerID) {
						old.State = "acknowledged"
					} else {
						old.OwnerID = ""
						old.OwnerName = ""
						old.AckAt = ""
						old.AckMethod = ""
						old.HandlingUntil = ""
					}
					old.Stage = "primary"
					old.Round = 0
					old.StageRound = 0
					old.SuccessfulRounds = 0
					old.CountedRound = 0
					old.SinceRoundSeconds = 0
					old.LevelActiveSeconds = 0
					old.LastTick = stamp(m.now())
					old.Exhausted = false
					old.DeferredReason = ""
					old.Generation++
					old.ResolutionNotified = false
					if e = saveResponse(tx, old); e != nil {
						return e
					}
					if e = auditResponse(tx, old, "resumed", "", "", "按当前责任组恢复响应", m.now()); e != nil {
						return e
					}
				}
				continue
			}
			if e = m.startResponseTx(tx, entry.event, entry.rule, g); e != nil {
				return e
			}
		}
	}
	return tx.Commit()
}

func (m *Module) cancelRuleResponsesTx(tx *sql.Tx, ruleID, reason string) error {
	rows, e := tx.Query("SELECT body FROM alert_responses WHERE json_extract(body,'$.rule_id')=? AND state NOT IN ('resolved','cancelled')", ruleID)
	if e != nil {
		return e
	}
	list := []IncidentResponse{}
	for rows.Next() {
		var raw string
		if e = rows.Scan(&raw); e != nil {
			rows.Close()
			return e
		}
		var r IncidentResponse
		if e = json.Unmarshal([]byte(raw), &r); e != nil {
			rows.Close()
			return e
		}
		list = append(list, r)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, r := range list {
		r.State = "cancelled"
		r.Generation++
		r.DeferredReason = reason
		r.ResolutionNotified = true
		if e = saveResponse(tx, r); e != nil {
			return e
		}
		if e = auditResponse(tx, r, "cancelled", "", "", reason, m.now()); e != nil {
			return e
		}
		if _, e = tx.Exec("UPDATE alert_assignments SET outcome='cancelled' WHERE response_id=? AND outcome='pending'", r.ID); e != nil {
			return e
		}
	}
	_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.rule_id')=?", ruleID)
	return e
}
