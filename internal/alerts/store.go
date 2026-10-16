package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/lightmoni/lightmoni/internal/shared"
	"net/http"
	"sort"
	"time"
)

func New(deps shared.Dependencies) (*Module, error) {
	if deps.DB == nil || deps.Query == nil || deps.Catalog == nil || deps.ReferencedTables == nil {
		return nil, errors.New("alerts requires DB, Query, Catalog and ReferencedTables")
	}
	if deps.Encrypt == nil || deps.Decrypt == nil {
		return nil, errors.New("alerts requires secret encryption")
	}
	_, err := deps.DB.Exec(`CREATE TABLE IF NOT EXISTS alert_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS alert_channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL,secret TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS alert_rules(id TEXT PRIMARY KEY,body TEXT NOT NULL,last_eval TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS alert_states(rule_id TEXT NOT NULL,fingerprint TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(rule_id,fingerprint));
 CREATE TABLE IF NOT EXISTS alert_events(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS alert_events_rule_time ON alert_events(rule_id,created_at);
 CREATE TABLE IF NOT EXISTS alert_outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,channel_id TEXT NOT NULL,target TEXT NOT NULL,status TEXT NOT NULL,next_attempt TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(event_id,channel_id,target));
 CREATE INDEX IF NOT EXISTS alert_outbox_due ON alert_outbox(status,next_attempt);`)
	if err != nil {
		return nil, err
	}
	if _, err = deps.DB.Exec("CREATE TABLE IF NOT EXISTS alert_send_attempts(id TEXT PRIMARY KEY,rate_key TEXT NOT NULL,attempted_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS alert_attempt_rate ON alert_send_attempts(rate_key,attempted_at); CREATE TABLE IF NOT EXISTS alert_rate_blocks(rate_key TEXT PRIMARY KEY,reason TEXT NOT NULL)"); err != nil {
		return nil, err
	}
	if err = normalizeQueueTimes(deps.DB); err != nil {
		return nil, err
	}
	m := &Module{deps: deps, client: &http.Client{Timeout: 10 * time.Second}, now: time.Now}
	if err = m.initResponses(); err != nil {
		return nil, err
	}
	return m, nil
}
func listBodies[T any](ctx context.Context, db *sql.DB, query string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var v T
		if err = json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (m *Module) groups(ctx context.Context) ([]Group, error) {
	groups, e := listBodies[Group](ctx, m.deps.DB, "SELECT body FROM alert_groups ORDER BY name")
	for i := range groups {
		groups[i].fillLegacyPolicies()
	}
	return groups, e
}
func (m *Module) rules(ctx context.Context) ([]Rule, error) {
	return listBodies[Rule](ctx, m.deps.DB, "SELECT body FROM alert_rules ORDER BY id")
}
func (m *Module) channel(ctx context.Context, channelID string, secret bool) (Channel, error) {
	var raw, sec string
	err := m.deps.DB.QueryRowContext(ctx, "SELECT body,secret FROM alert_channels WHERE id=?", channelID).Scan(&raw, &sec)
	var c Channel
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal([]byte(raw), &c); err != nil {
		return c, err
	}
	c.HasSecret = sec != ""
	if secret && sec != "" {
		plain, e := m.deps.Decrypt(sec)
		if e != nil {
			return c, e
		}
		var secrets map[string]string
		if e = json.Unmarshal([]byte(plain), &secrets); e != nil {
			return c, e
		}
		for k, v := range secrets {
			c.Config[k] = v
		}
	}
	return c, nil
}
func (m *Module) route(ctx context.Context, r Rule) ([]Route, []string, error) {
	tables, e := m.deps.Catalog(ctx)
	if e != nil {
		return nil, nil, e
	}
	groups, e := m.groups(ctx)
	if e != nil {
		return nil, nil, e
	}
	gm := map[string]Group{}
	for _, g := range groups {
		gm[g.ID] = g
	}
	tm := map[string]shared.Table{}
	for _, t := range tables {
		tm[t.ID] = t
	}
	routes := []Route{}
	warnings := []string{}
	index := map[string]int{}
	groupIDs := append([]string{}, r.GroupIDs...)
	for _, tid := range r.SourceTableIDs {
		t, ok := tm[tid]
		if !ok {
			return nil, nil, errors.New("source table no longer exists: " + tid)
		}
		if len(r.GroupIDs) == 0 {
			if t.AlertGroupID == "" {
				warnings = append(warnings, t.Name+": 未配置有效告警组/目标")
			} else {
				groupIDs = append(groupIDs, t.AlertGroupID)
			}
		}
	}
	for _, gid := range groupIDs {
		g, ok := gm[gid]
		if !ok || !g.Enabled || (len(g.Targets) == 0 && len(g.Members) == 0) {
			warnings = append(warnings, gid+": 未配置有效告警组/目标")
			continue
		}
		if len(g.Members) > 0 {
			users := m.activeMembers(ctx, g.onCall(m.now()).Primary)
			targets, notes, e := m.responseTargets(ctx, g, priority(r.Severity), users)
			if e != nil {
				return nil, nil, e
			}
			warnings = append(warnings, notes...)
			for _, t := range targets {
				routes = append(routes, Route{Target: t.Target, GroupIDs: []string{g.ID}, UserID: t.UserID})
			}
			continue
		}
		for _, target := range g.Targets {
			c, e := m.channel(ctx, target.ChannelID, false)
			if e != nil || !c.Enabled {
				warnings = append(warnings, g.Name+": 通知渠道不可用")
				continue
			}
			key := target.ChannelID + recipientKey(target.Recipient)
			if n, ok := index[key]; ok {
				mentions := map[string]bool{}
				for _, v := range routes[n].Target.Recipient.Mentions {
					mentions[v] = true
				}
				for _, v := range target.Recipient.Mentions {
					if !mentions[v] {
						routes[n].Target.Recipient.Mentions = append(routes[n].Target.Recipient.Mentions, v)
						mentions[v] = true
					}
				}
				sort.Strings(routes[n].Target.Recipient.Mentions)
				found := false
				for _, v := range routes[n].GroupIDs {
					if v == g.ID {
						found = true
					}
				}
				if !found {
					routes[n].GroupIDs = append(routes[n].GroupIDs, g.ID)
				}
			} else {
				index[key] = len(routes)
				routes = append(routes, Route{Target: target, GroupIDs: []string{g.ID}})
			}
		}
	}
	return routes, warnings, nil
}
func (m *Module) updateDelivery(ctx context.Context, d Delivery) error {
	// A native phone callback can complete while the sending HTTP request is still
	// running. Preserve that monotonic fact when the request later saves its result.
	_, e := m.deps.DB.ExecContext(ctx, `UPDATE alert_outbox SET
	status=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN 'confirmed' ELSE ? END,
	next_attempt=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN '' ELSE ? END,
	body=CASE WHEN json_extract(body,'$.delivery_status')='answered' THEN
	 json_set(?,'$.status','confirmed','$.next_attempt','','$.delivery_status','answered','$.provider_id',json_extract(body,'$.provider_id'))
	 ELSE ? END WHERE id=?`, d.Status, d.NextAttempt, encode(d), encode(d), d.ID)
	return e
}
