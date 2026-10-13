package alerts

import (
	"context"
	"encoding/json"
	"time"
)

// Recovery follows the actual responders of the episode, rather than paging
// whichever new person happens to be on call at the recovery time.
func (m *Module) NotifyResolved(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	list, e := listBodies[IncidentResponse](ctx, m.deps.DB, "SELECT body FROM alert_responses WHERE state='resolved' AND json_extract(body,'$.resolution_notified')=0 ORDER BY created_at LIMIT 100")
	if e != nil {
		return e
	}
	silences, e := listBodies[Silence](ctx, m.deps.DB, "SELECT body FROM alert_silences")
	if e != nil {
		return e
	}
	for _, r := range list {
		if allowedResponse(r, m.now(), silences, "") != "" {
			continue
		}
		g, e := m.group(ctx, r.GroupID)
		if e != nil || !g.Enabled {
			continue
		}
		rows, e := m.deps.DB.QueryContext(ctx, "SELECT user_id FROM alert_assignments WHERE response_id=?", r.ID)
		if e != nil {
			return e
		}
		users := []string{}
		for rows.Next() {
			var u string
			if e = rows.Scan(&u); e != nil {
				rows.Close()
				return e
			}
			if includes(g.Members, u) {
				users = append(users, u)
			}
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		if r.OwnerID != "" && includes(g.Members, r.OwnerID) {
			users = append(users, r.OwnerID)
		}
		users = m.activeMembers(ctx, users)
		p := r.Group.policy(r.Priority)
		p.Methods = []string{"email", "chat", "webhook", "push"}
		group := r.Group
		group.Policies = map[string]PriorityPolicy{r.Priority: p}
		targets, _, e := m.responseTargets(ctx, group, r.Priority, users)
		if e != nil {
			return e
		}
		tx, e := m.deps.DB.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		for _, t := range targets {
			payload := r.Event
			payload.ID = r.ID + ":resolved"
			payload.Message = "[已恢复] " + r.Event.RuleName + "\n责任组 " + r.GroupName + "\n" + r.Event.Message
			d := Delivery{ID: id(), EventID: payload.ID, RuleID: r.RuleID, GroupIDs: []string{r.GroupID}, ChannelID: t.Target.ChannelID, Recipient: t.Target.Recipient, Status: "queued", NextAttempt: stamp(m.now()), CreatedAt: stamp(m.now()), UpdatedAt: stamp(m.now()), Payload: payload, ResponseID: r.ID, UserID: t.UserID, UserIDs: t.UserIDs, Generation: r.Generation, Priority: r.Priority}
			if _, e = tx.Exec("INSERT OR IGNORE INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, recipientKey(d.Recipient), d.Status, d.NextAttempt, d.CreatedAt, encode(d)); e != nil {
				break
			}
		}
		r.ResolutionNotified = true
		if e == nil {
			e = saveResponse(tx, r)
		}
		if e == nil {
			e = tx.Commit()
		} else {
			tx.Rollback()
		}
		if e != nil {
			return e
		}
	}
	return nil
}

func (m *Module) receiptTimestamp(c Channel, event map[string]any, d Delivery) string {
	var at string
	if c.Type == "tencent_voice" {
		seconds, _ := json.Number(valueString(event["accept_time"])).Int64()
		if seconds > 0 {
			at = stamp(time.Unix(seconds, 0))
		}
	} else {
		at = valueString(event["b_start_time"])
		if at == "" {
			at = valueString(event["start_time"])
		}
		if at == "" {
			at = valueString(event["status_time"])
		}
		if parse(at).IsZero() {
			loc, _ := time.LoadLocation("Asia/Shanghai")
			v, e := time.ParseInLocation("2006-01-02 15:04:05", at, loc)
			if e == nil {
				at = stamp(v)
			}
		}
	}
	if parse(at).Before(parse(d.CreatedAt)) || parse(at).After(m.now()) || parse(at).IsZero() {
		return stamp(m.now())
	}
	return at
}
