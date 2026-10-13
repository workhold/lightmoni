package alerts

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func (m *Module) initResponses() error {
	_, e := m.deps.DB.Exec(`
CREATE TABLE IF NOT EXISTS user_notification_profiles(user_id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_responses(id TEXT PRIMARY KEY,episode TEXT NOT NULL,group_id TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(episode,group_id));
CREATE INDEX IF NOT EXISTS alert_responses_state ON alert_responses(state,created_at);
CREATE TABLE IF NOT EXISTS alert_response_events(id TEXT PRIMARY KEY,response_id TEXT NOT NULL,at TEXT NOT NULL,body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS alert_response_events_response ON alert_response_events(response_id,at);
CREATE TABLE IF NOT EXISTS alert_assignments(response_id TEXT NOT NULL,user_id TEXT NOT NULL,user_name TEXT NOT NULL,stage TEXT NOT NULL,priority TEXT NOT NULL,notified_at TEXT NOT NULL,ack_at TEXT NOT NULL DEFAULT '',ack_method TEXT NOT NULL DEFAULT '',outcome TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(response_id,user_id));
CREATE INDEX IF NOT EXISTS alert_assignments_time ON alert_assignments(notified_at,user_id);
CREATE TABLE IF NOT EXISTS alert_claim_tokens(token_hash TEXT PRIMARY KEY,response_id TEXT NOT NULL,user_id TEXT NOT NULL,method TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_silences(id TEXT PRIMARY KEY,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_directory_sources(id TEXT PRIMARY KEY,body TEXT NOT NULL,secret TEXT NOT NULL DEFAULT '');`)
	if e == nil {
		_, e = m.deps.DB.Exec("CREATE TABLE IF NOT EXISTS alert_voice_receipts(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,provider_id TEXT NOT NULL,created_at TEXT NOT NULL,body TEXT NOT NULL,processed INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS alert_voice_receipts_pending ON alert_voice_receipts(processed,created_at)")
	}
	return e
}
func tokenHash(v string) string { s := sha256.Sum256([]byte(v)); return hex.EncodeToString(s[:]) }
func saveResponse(tx *sql.Tx, r IncidentResponse) error {
	_, e := tx.Exec("UPDATE alert_responses SET state=?,body=? WHERE id=?", r.State, encode(r), r.ID)
	return e
}
func auditResponse(tx *sql.Tx, r IncidentResponse, kind, user, method, message string, at time.Time) error {
	v := ResponseAudit{ID: id(), ResponseID: r.ID, At: stamp(at), Kind: kind, UserID: user, Method: method, Message: message}
	_, e := tx.Exec("INSERT INTO alert_response_events(id,response_id,at,body) VALUES(?,?,?,?)", v.ID, v.ResponseID, v.At, encode(v))
	return e
}
func (m *Module) response(ctx context.Context, responseID string) (IncidentResponse, error) {
	var raw string
	e := m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_responses WHERE id=?", responseID).Scan(&raw)
	var r IncidentResponse
	if e == nil {
		e = json.Unmarshal([]byte(raw), &r)
	}
	return r, e
}
func (m *Module) group(ctx context.Context, gid string) (Group, error) {
	var raw string
	e := m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_groups WHERE id=?", gid).Scan(&raw)
	var g Group
	if e == nil {
		e = json.Unmarshal([]byte(raw), &g)
	}
	return g, e
}
func (m *Module) member(ctx context.Context, userID string) (string, shared.NotificationProfile, bool) {
	var name string
	var active bool
	if m.deps.DB.QueryRowContext(ctx, "SELECT name,active FROM users WHERE id=?", userID).Scan(&name, &active) != nil || !active {
		return "", shared.NotificationProfile{}, false
	}
	p := shared.NotificationProfile{UserID: userID}
	var raw string
	if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM user_notification_profiles WHERE user_id=?", userID).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &p)
	}
	return name, p, true
}
func (m *Module) activeMembers(ctx context.Context, users []string) []string {
	out := []string{}
	for _, u := range uniqueUsers(users) {
		if _, _, ok := m.member(ctx, u); ok {
			out = append(out, u)
		}
	}
	return out
}
func channelMethod(typ string) string {
	switch typ {
	case "smtp":
		return "email"
	case "aliyun_sms", "tencent_sms", "huawei_sms":
		return "sms"
	case "aliyun_voice", "tencent_voice":
		return "voice"
	case "feishu", "feishu_app", "dingtalk", "wecom":
		return "chat"
	case "pushplus":
		return "push"
	default:
		return "webhook"
	}
}

type responseTarget struct {
	Target  Target
	UserID  string
	UserIDs []string
}

func (m *Module) responseTargets(ctx context.Context, g Group, p string, users []string) ([]responseTarget, []string, error) {
	channels, e := listBodies[Channel](ctx, m.deps.DB, "SELECT body FROM alert_channels ORDER BY name,id")
	if e != nil {
		return nil, nil, e
	}
	out := []responseTarget{}
	warnings := []string{}
	auto := map[string]bool{}
	methods := g.policy(p).Methods
	for _, c := range channels {
		kind := channelMethod(c.Type)
		if !c.Enabled || !includes(methods, kind) || (len(g.ChannelIDs) > 0 && !includes(g.ChannelIDs, c.ID)) {
			continue
		}
		// Default picks one provider of each specific channel type; selected providers are explicit.
		if len(g.ChannelIDs) == 0 && auto[kind] && kind != "chat" {
			continue
		}
		auto[kind] = true
		if c.Type == "feishu" || c.Type == "dingtalk" || c.Type == "wecom" || c.Type == "webhook" || c.Type == "pushplus" {
			mentions := []string{}
			for _, u := range users {
				_, profile, _ := m.member(ctx, u)
				v := profile.FeishuID
				if c.Type == "dingtalk" {
					v = profile.DingtalkID
					if v == "" {
						v = profile.Phone
						if strings.HasPrefix(v, "+86") && len(v) == 14 {
							v = strings.TrimPrefix(v, "+86")
						}
					}
				}
				if c.Type == "wecom" {
					v = profile.WecomID
				}
				if v != "" {
					mentions = append(mentions, v)
				}
			}
			r := Recipient{Kind: "channel", Value: "bound", Mentions: mentions}
			if c.Type == "pushplus" {
				r = Recipient{Kind: "self"}
			}
			out = append(out, responseTarget{Target: Target{c.ID, r}, UserIDs: users})
			continue
		}
		for _, u := range users {
			name, profile, ok := m.member(ctx, u)
			if !ok {
				continue
			}
			r := Recipient{Kind: "phone", Value: profile.Phone}
			if kind == "email" {
				r = Recipient{Kind: "email", Value: profile.Email}
			}
			if c.Type == "feishu_app" {
				r = Recipient{Kind: "feishu_user", Value: profile.FeishuID}
			}
			if r.Value == "" {
				warnings = append(warnings, name+"缺少"+kind+"联系方式")
				continue
			}
			if e := validateRecipient(c.Type, &r); e != nil {
				warnings = append(warnings, name+"："+e.Error())
				continue
			}
			out = append(out, responseTarget{Target: Target{c.ID, r}, UserID: u, UserIDs: []string{u}})
		}
	}
	if len(out) == 0 {
		warnings = append(warnings, "没有可用通知渠道或联系方式")
	}
	return out, warnings, nil
}
func (m *Module) startResponseTx(tx *sql.Tx, event Event, rule Rule, g Group) error {
	if len(g.Members) == 0 {
		return nil
	}
	if event.Kind == "reminder" {
		return nil
	}
	if event.Kind == "resolved" || event.Kind == "health_resolved" {
		var raw string
		if tx.QueryRow("SELECT body FROM alert_responses WHERE episode=? AND group_id=?", event.Episode, g.ID).Scan(&raw) != nil {
			return nil
		}
		var r IncidentResponse
		_ = json.Unmarshal([]byte(raw), &r)
		if r.State == "resolved" {
			return nil
		}
		r.State, r.ResolvedAt, r.Generation = "resolved", event.CreatedAt, r.Generation+1
		r.Event = event
		if e := saveResponse(tx, r); e != nil {
			return e
		}
		if _, e := tx.Exec("UPDATE alert_assignments SET outcome='recovered' WHERE response_id=? AND outcome='pending'", r.ID); e != nil {
			return e
		}
		if _, e := tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", r.ID); e != nil {
			return e
		}
		return auditResponse(tx, r, "resolved", "", "", "监测已恢复，停止后续通知", parse(event.CreatedAt))
	}
	r := IncidentResponse{ID: id(), Episode: event.Episode, RuleID: rule.ID, GroupID: g.ID, GroupName: g.Name, State: "unclaimed", Priority: priority(rule.Severity), OriginalPriority: priority(rule.Severity), Stage: "primary", CreatedAt: event.CreatedAt, LastTick: event.CreatedAt, Generation: 1, Group: g, Event: event, Evidence: Evidence{Status: "pending", Logs: []map[string]any{}, TraceIDs: []string{}}}
	if parse(r.LastTick).Before(m.now()) {
		r.LastTick = stamp(m.now())
	}
	if rule.EvidenceProfile == nil || rule.EvidenceProfile.LogTableID == "" {
		r.Evidence.Status = "unconfigured"
	}
	res, e := tx.Exec("INSERT OR IGNORE INTO alert_responses(id,episode,group_id,state,created_at,body) VALUES(?,?,?,?,?,?)", r.ID, r.Episode, r.GroupID, r.State, r.CreatedAt, encode(r))
	if e != nil {
		return e
	}
	n, e := res.RowsAffected()
	if e != nil || n == 0 {
		return e
	}
	return auditResponse(tx, r, "triggered", "", "", "等待值班人员接手", parse(event.CreatedAt))
}
func (m *Module) enqueueRound(ctx context.Context, r *IncidentResponse, now time.Time) error {
	previousStage := r.Stage
	shift := r.Group.onCall(now)
	var users, warnings []string
	var targets []responseTarget
	var e error
	for {
		users = shift.Primary
		if r.Stage == "backup" {
			users = shift.Backup
		} else if r.Stage == "fallback" {
			users = r.Group.Fallback
		}
		users = m.activeMembers(ctx, users)
		targets, warnings, e = m.responseTargets(ctx, r.Group, r.Priority, users)
		if e != nil {
			return e
		}
		if len(users) == 0 {
			targets = nil
			warnings = append(warnings, "主备及兜底没有有效值班人员")
		}
		if len(targets) > 0 || r.Stage == "fallback" {
			break
		}
		if r.Stage == "primary" {
			r.Stage = "backup"
		} else {
			r.Stage = "fallback"
		}
	}
	methods := map[string]string{}
	if previousStage != r.Stage {
		r.StageRound = 0
		r.Generation++
	}
	for _, t := range targets {
		methods[t.Target.ChannelID] = channelMethodByID(ctx, m, t.Target.ChannelID)
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if len(targets) == 0 {
		r.Exhausted = true
		r.DeferredReason = strings.Join(warnings, "；")
		if e = saveResponse(tx, *r); e != nil {
			return e
		}
		if e = auditResponse(tx, *r, "unreachable", "", "", r.DeferredReason, now); e != nil {
			return e
		}
		return tx.Commit()
	}
	var pending int
	if e = tx.QueryRow("SELECT count(*) FROM alert_outbox WHERE status IN ('queued','retry','sending')").Scan(&pending); e != nil {
		return e
	}
	if pending+len(targets) > 10000 {
		return errors.New("notification queue capacity reached")
	}
	r.Round++
	r.StageRound++
	r.SinceRoundSeconds = 0
	r.LastRoundAt = stamp(now)
	r.DeferredReason = strings.Join(warnings, "；")
	for _, t := range targets {
		token := id()
		method := methods[t.Target.ChannelID]
		link := strings.TrimRight(m.deps.ExternalURL, "/") + "/a/" + url.PathEscape(token)
		if _, e = tx.Exec("INSERT INTO alert_claim_tokens(token_hash,response_id,user_id,method,expires_at) VALUES(?,?,?,?,?)", tokenHash(token), r.ID, t.UserID, method+"_link", stamp(now.Add(7*24*time.Hour))); e != nil {
			return e
		}
		payload := r.Event
		payload.ID = fmt.Sprintf("%s:%d:%d", r.ID, r.Generation, r.Round)
		payload.Message = fmt.Sprintf("[%s] %s\n责任组 %s · %s · 第%d轮\n%s", r.Priority, payload.RuleName, r.GroupName, r.Stage, r.Round, r.Event.Message)
		d := Delivery{ID: id(), EventID: payload.ID, RuleID: r.RuleID, GroupIDs: []string{r.GroupID}, TableIDs: payload.SourceTableIDs, ChannelID: t.Target.ChannelID, Recipient: t.Target.Recipient, Status: "queued", NextAttempt: stamp(now), CreatedAt: stamp(now), UpdatedAt: stamp(now), Payload: payload, ResponseID: r.ID, Stage: r.Stage, UserID: t.UserID, UserIDs: t.UserIDs, Priority: r.Priority, AckURL: link, Generation: r.Generation}
		if _, e = tx.Exec("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, recipientKey(d.Recipient), d.Status, d.NextAttempt, d.CreatedAt, encode(d)); e != nil {
			return e
		}
	}
	if e = saveResponse(tx, *r); e != nil {
		return e
	}
	if e = auditResponse(tx, *r, "notifying", "", "", fmt.Sprintf("%s · %s · 第%d轮，%d人", r.Priority, r.Stage, r.Round, len(users)), now); e != nil {
		return e
	}
	return tx.Commit()
}

// A channel's type is metadata already present in the selected target. It must be
// loaded before opening a single-connection SQLite transaction.
func channelMethodByID(ctx context.Context, m *Module, cid string) string {
	c, e := m.channel(ctx, cid, false)
	if e != nil {
		return "notification"
	}
	switch c.Type {
	case "feishu":
		return "feishu"
	case "dingtalk":
		return "dingtalk"
	case "wecom":
		return "wecom"
	}
	return channelMethod(c.Type)
}

func (m *Module) TickResponses(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e := m.syncResponseRoutes(ctx); e != nil {
		return e
	}
	rs, e := listBodies[IncidentResponse](ctx, m.deps.DB, "SELECT body FROM alert_responses WHERE state NOT IN ('resolved','cancelled') ORDER BY json_extract(body,'$.last_tick'),id LIMIT 1000")
	if e != nil {
		return e
	}
	silences, e := listBodies[Silence](ctx, m.deps.DB, "SELECT body FROM alert_silences")
	if e != nil {
		return e
	}
	now := m.now()
	for _, r := range rs {
		g, e := m.group(ctx, r.GroupID)
		if e != nil || !g.Enabled {
			continue
		}
		r.Group.Members = g.Members // Removal and disabling always take effect before dispatch.
		var ruleRaw string
		if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", r.RuleID).Scan(&ruleRaw) != nil {
			continue
		}
		var rule Rule
		_ = json.Unmarshal([]byte(ruleRaw), &rule)
		if !rule.Enabled {
			continue
		}
		reason := allowedResponse(r, now, silences, rule.SilenceUntil)
		delta := 0.0
		if r.State == "unclaimed" {
			delta = responseActiveSeconds(r, parse(r.LastTick), now, silences, rule.SilenceUntil)
		}
		r.LastTick = stamp(now)
		if r.State == "acknowledged" {
			_, _, ownerActive := m.member(ctx, r.OwnerID)
			ownerActive = ownerActive && includes(g.Members, r.OwnerID)
			if ownerActive && (parse(r.HandlingUntil).After(now) || r.HandlingUntil == "") {
				if _, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=? WHERE id=?", encode(r), r.ID); e != nil {
					return e
				}
				continue
			}
			if reason != "" {
				r.DeferredReason = reason
				if _, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=? WHERE id=?", encode(r), r.ID); e != nil {
					return e
				}
				continue
			}
			r.State = "unclaimed"
			r.Generation++
			r.Exhausted = false
			r.OwnerID = ""
			r.OwnerName = ""
			r.SinceRoundSeconds = 0
			r.Round = 0
			r.Stage = "backup"
			r.StageRound = 0
			delta = 0
			r.LevelActiveSeconds = 0
			tx, e := m.deps.DB.BeginTx(ctx, nil)
			if e != nil {
				return e
			}
			e = saveResponse(tx, r)
			if e == nil {
				e = auditResponse(tx, r, "handling_timeout", "", "", "处理期限已到，重新通知备班", now)
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
		r.ActiveSeconds += delta
		r.LevelActiveSeconds += delta
		r.SinceRoundSeconds += delta
		oldReason := r.DeferredReason
		if reason != "" {
			r.DeferredReason = reason
			_, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=? WHERE id=?", encode(r), r.ID)
			if e != nil {
				return e
			}
			continue
		}
		if strings.HasPrefix(oldReason, "静默") || oldReason == "通知窗口外" || oldReason == "规则静默" {
			r.SinceRoundSeconds = float64(r.Group.policy(r.Priority).RepeatSeconds)
			r.DeferredReason = ""
		}
		if r.Exhausted {
			_, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=? WHERE id=?", encode(r), r.ID)
			if e != nil {
				return e
			}
			continue
		}
		p := r.Group.policy(r.Priority)
		var accepted int
		if r.Round > 0 {
			e = m.deps.DB.QueryRowContext(ctx, "SELECT count(*) FROM alert_outbox WHERE event_id=? AND status IN ('accepted','succeeded','confirmed')", fmt.Sprintf("%s:%d:%d", r.ID, r.Generation, r.Round)).Scan(&accepted)
			if e != nil {
				return e
			}
			if accepted > 0 && r.CountedRound != r.Round {
				r.SuccessfulRounds++
				r.CountedRound = r.Round
			}
		}
		// All timestamps count eligible time, including time across worker restarts.
		stageChanged := false
		if p.FallbackAfterSeconds > 0 && r.LevelActiveSeconds >= float64(p.FallbackAfterSeconds) && r.Stage != "fallback" {
			r.Stage = "fallback"
			stageChanged = true
		} else if p.BackupAfterSeconds > 0 && r.LevelActiveSeconds >= float64(p.BackupAfterSeconds) && r.Stage == "primary" {
			r.Stage = "backup"
			stageChanged = true
		}
		if p.EscalateAfterRounds > 0 && r.SuccessfulRounds >= p.EscalateAfterRounds && r.SinceRoundSeconds >= float64(p.RepeatSeconds) && priorityRank(p.EscalateTo) < priorityRank(r.Priority) {
			r.Priority = p.EscalateTo
			r.LevelActiveSeconds = 0
			r.Round = 0
			r.SuccessfulRounds = 0
			r.CountedRound = 0
			r.SinceRoundSeconds = 0
			r.Generation++
			stageChanged = true
			p = r.Group.policy(r.Priority)
			if reason = allowedResponse(r, now, silences, rule.SilenceUntil); reason != "" {
				r.DeferredReason = reason
				_, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=? WHERE id=?", encode(r), r.ID)
				if e != nil {
					return e
				}
				continue
			}
		}
		if stageChanged {
			r.Generation++
			r.Exhausted = false
			r.StageRound = 0
		}
		if r.Round == 0 || stageChanged || r.SinceRoundSeconds >= float64(p.RepeatSeconds) {
			if p.MaxRounds > 0 && r.StageRound >= p.MaxRounds {
				if (r.Stage == "primary" && p.BackupAfterSeconds > 0) || (r.Stage != "fallback" && p.FallbackAfterSeconds > 0) {
					r.DeferredReason = "本层通知次数已到，等待下一层升级"
				} else {
					r.Exhausted = true
					r.DeferredReason = "升级已耗尽，等待人工接手"
				}
			} else if e = m.enqueueRound(ctx, &r, now); e != nil {
				return e
			}
		}
		_, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET state=?,body=? WHERE id=?", r.State, encode(r), r.ID)
		if e != nil {
			return e
		}
	}
	return nil
}

func (m *Module) canRespond(ctx context.Context, r IncidentResponse, u shared.User) bool {
	if u.Role == "admin" {
		return true
	}
	g, e := m.group(ctx, r.GroupID)
	return e == nil && includes(g.Members, u.ID)
}
func (m *Module) acknowledge(ctx context.Context, responseID, userID, method string, now time.Time) (IncidentResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, e := m.response(ctx, responseID)
	if e != nil {
		return r, e
	}
	name, _, active := m.member(ctx, userID)
	g, ge := m.group(ctx, r.GroupID)
	if !active || ge != nil || !includes(g.Members, userID) {
		return r, errors.New("接手人不是当前有效告警组成员")
	}
	if r.State == "resolved" || r.State == "cancelled" {
		return r, errors.New("告警已恢复")
	}
	var ruleRaw string
	var currentRule Rule
	if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", r.RuleID).Scan(&ruleRaw) != nil {
		return r, errors.New("告警规则已删除")
	}
	_ = json.Unmarshal([]byte(ruleRaw), &currentRule)
	currentGroups, e := m.ruleResponseGroups(ctx, currentRule)
	if e != nil {
		return r, e
	}
	routed := false
	for _, group := range currentGroups {
		routed = routed || group.ID == r.GroupID
	}
	if !currentRule.Enabled || !routed {
		return r, errors.New("告警规则已暂停或责任组已变更")
	}
	if r.State == "acknowledged" {
		if r.OwnerID == userID {
			return r, nil
		}
		return r, fmt.Errorf("已由%s接手", r.OwnerName)
	}
	r.State, r.OwnerID, r.OwnerName, r.AckMethod, r.AckAt = "acknowledged", userID, name, method, stamp(now)
	r.Generation++
	r.LastTick = stamp(now)
	r.Exhausted = false
	r.DeferredReason = ""
	if sec := r.Group.policy(r.Priority).HandlingSeconds; sec > 0 {
		r.HandlingUntil = stamp(now.Add(time.Duration(sec) * time.Second))
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return r, e
	}
	defer tx.Rollback()
	if e = saveResponse(tx, r); e != nil {
		return r, e
	}
	if _, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", r.ID); e != nil {
		return r, e
	}
	if _, e = tx.Exec("UPDATE alert_assignments SET outcome='peer_claimed' WHERE response_id=? AND outcome='pending' AND user_id<>?", r.ID, userID); e != nil {
		return r, e
	}
	if _, e = tx.Exec("UPDATE alert_assignments SET ack_at=CASE WHEN ack_at='' THEN ? ELSE ack_at END,ack_method=CASE WHEN ack_at='' THEN ? ELSE ack_method END,outcome='claimed' WHERE response_id=? AND user_id=?", r.AckAt, method, r.ID, userID); e != nil {
		return r, e
	}
	if e = auditResponse(tx, r, "acknowledged", userID, method, name+"已接手", now); e != nil {
		return r, e
	}
	return r, tx.Commit()
}
func (m *Module) recordNotified(ctx context.Context, d Delivery, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d.ResponseID == "" || d.Payload.Kind == "resolved" || d.Payload.Kind == "health_resolved" || (d.Status != "accepted" && d.Status != "succeeded" && d.Status != "confirmed") {
		return nil
	}
	r, e := m.response(ctx, d.ResponseID)
	if e != nil {
		return e
	}
	names := map[string]string{}
	for _, u := range d.UserIDs {
		name, _, ok := m.member(ctx, u)
		if ok {
			names[u] = name
		}
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for u, name := range names {
		stage := d.Stage
		if stage == "" {
			stage = r.Stage
		}
		outcome, ackAt, method := "pending", "", ""
		if r.State == "acknowledged" {
			outcome = "peer_claimed"
			if r.OwnerID == u {
				outcome, ackAt, method = "claimed", r.AckAt, r.AckMethod
			}
		}
		if r.State == "resolved" {
			outcome = "recovered"
		}
		if _, e = tx.Exec("INSERT OR IGNORE INTO alert_assignments(response_id,user_id,user_name,stage,priority,notified_at,ack_at,ack_method,outcome) VALUES(?,?,?,?,?,?,?,?,?)", r.ID, u, name, stage, d.Priority, stamp(at), ackAt, method, outcome); e != nil {
			return e
		}
	}
	return tx.Commit()
}
func (m *Module) deliveryAllowed(ctx context.Context, d Delivery) (bool, string, error) {
	r, e := m.response(ctx, d.ResponseID)
	if e != nil {
		return false, "告警事件不存在", e
	}
	isRecovery := d.Payload.Kind == "resolved" || d.Payload.Kind == "health_resolved"
	if ((!isRecovery && r.State != "unclaimed") || (isRecovery && r.State != "resolved")) || d.Generation != r.Generation {
		return false, "告警已接手、恢复或升级", nil
	}
	g, e := m.group(ctx, r.GroupID)
	if e != nil || !g.Enabled {
		return false, "告警组不可用", nil
	}
	r.Group.Members = g.Members
	if d.UserID != "" {
		if !includes(g.Members, d.UserID) {
			return false, "接收人已移出告警组", nil
		}
		if _, profile, ok := m.member(ctx, d.UserID); !ok {
			return false, "接收人已停用", nil
		} else {
			c, e := m.channel(ctx, d.ChannelID, false)
			if e != nil {
				return false, "渠道不存在", e
			}
			expected := d.Recipient
			switch expected.Kind {
			case "phone":
				expected.Value = profile.Phone
			case "email":
				expected.Value = profile.Email
			case "feishu_user":
				expected.Value = profile.FeishuID
			}
			if validateRecipient(c.Type, &expected) != nil || expected.Value != d.Recipient.Value {
				return false, "接收人联系方式已变更", nil
			}
		}
	}
	for _, uid := range d.UserIDs {
		if !includes(g.Members, uid) {
			return false, "通知成员已变更", nil
		}
	}
	silences, e := listBodies[Silence](ctx, m.deps.DB, "SELECT body FROM alert_silences")
	if e != nil {
		return false, "", e
	}
	var raw string
	var rule Rule
	if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", r.RuleID).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &rule)
	}
	if !rule.Enabled {
		return false, "规则已禁用", nil
	}
	groups, e := m.ruleResponseGroups(ctx, rule)
	if e != nil {
		return false, "", e
	}
	routed := false
	for _, g := range groups {
		routed = routed || g.ID == r.GroupID
	}
	if !routed {
		return false, "责任组路由已变更", nil
	}
	if reason := allowedResponse(r, m.now(), silences, rule.SilenceUntil); reason != "" {
		return false, reason, nil
	}
	return true, "", nil
}

func (m *Module) validateGroupResponse(ctx context.Context, g *Group) error {
	if g.Timezone == "" {
		g.Timezone = "Asia/Shanghai"
	}
	if _, e := time.LoadLocation(g.Timezone); e != nil {
		return e
	}
	g.Members = uniqueUsers(g.Members)
	if len(g.Members) > 100 {
		return errors.New("告警组最多100名成员")
	}
	if len(g.Members) == 0 {
		return nil
	} // auxiliary destinations can still be used by simple webhook groups.
	if len(g.ChannelIDs) == 0 {
		return errors.New("请选择系统通知接入")
	}
	for _, u := range g.Members {
		if _, _, ok := m.member(ctx, u); !ok {
			return fmt.Errorf("无效或停用的组成员：%s", u)
		}
	}
	validateUsers := func(users []string) error {
		for _, u := range users {
			if !includes(g.Members, u) {
				return fmt.Errorf("值班人员必须是告警组成员：%s", u)
			}
		}
		return nil
	}
	for _, v := range [][]string{g.Primary, g.Backup, g.Fallback} {
		if e := validateUsers(v); e != nil {
			return e
		}
	}
	s := &g.Schedule
	if s.Timezone == "" {
		s.Timezone = g.Timezone
	}
	if _, e := time.LoadLocation(s.Timezone); e != nil {
		return e
	}
	if s.Mode == "" {
		s.Mode = "fixed"
	}
	if s.Mode != "fixed" && s.Mode != "daily" && s.Mode != "weekly" && s.Mode != "custom" {
		return errors.New("无效的排班周期")
	}
	if s.Mode != "fixed" && (parse(s.Anchor).IsZero() || len(s.Shifts) == 0) {
		return errors.New("周期排班需要起点和班次")
	}
	if s.Mode == "custom" && (s.IntervalDays < 1 || s.IntervalDays > 365) {
		return errors.New("自定义班次周期为1到365天")
	}
	if len(s.Shifts) > 52 || len(s.Overrides) > 100 {
		return errors.New("排班数量超限")
	}
	for _, shift := range s.Shifts {
		if e := validateUsers(shift.Primary); e != nil {
			return e
		}
		if e := validateUsers(shift.Backup); e != nil {
			return e
		}
	}
	for i, o := range s.Overrides {
		if parse(o.From).IsZero() || !parse(o.Until).After(parse(o.From)) {
			return errors.New("替班时间无效")
		}
		if e := validateUsers(o.Primary); e != nil {
			return e
		}
		if e := validateUsers(o.Backup); e != nil {
			return e
		}
		for j := 0; j < i; j++ {
			other := s.Overrides[j]
			if parse(o.From).Before(parse(other.Until)) && parse(o.Until).After(parse(other.From)) {
				return errors.New("替班时间不能重叠")
			}
		}
	}
	for key, p := range g.Policies {
		if priority(key) != key {
			return errors.New("策略级别为P0至P3")
		}
		for _, method := range p.Methods {
			if !includes([]string{"email", "sms", "voice", "chat", "webhook", "push"}, method) {
				return errors.New("无效的通知方式")
			}
		}
		if p.Start != "" || p.End != "" {
			if _, e := clockMinutes(p.Start); e != nil {
				return e
			}
			if _, e := clockMinutes(p.End); e != nil {
				return e
			}
		}
		for _, d := range p.Weekdays {
			if d < 0 || d > 6 {
				return errors.New("无效的星期")
			}
		}
		if p.RepeatSeconds < 10 || p.RepeatSeconds > 86400 || p.MaxRounds < 1 || p.MaxRounds > 30 || p.HandlingSeconds < 0 || p.HandlingSeconds > 7*86400 || p.BackupAfterSeconds < 0 || p.FallbackAfterSeconds < 0 || p.EscalateAfterRounds < 0 {
			return errors.New("通知间隔至少10秒，轮次1到30，处理期限不超过7天")
		}
		if p.EscalateAfterRounds > 0 && (priority(p.EscalateTo) != p.EscalateTo || priorityRank(p.EscalateTo) >= priorityRank(key)) {
			return errors.New("升级目标必须为更高优先级")
		}
	}
	for _, cid := range g.ChannelIDs {
		if _, e := m.channel(ctx, cid, false); e != nil {
			return errors.New("通知接入不存在")
		}
	}
	if len(g.Primary) == 0 && len(s.Shifts) == 0 {
		return errors.New("至少配置固定主班或周期班次")
	}
	return nil
}

func responderOrder(v []string) { sort.Strings(v) }

func (m *Module) ruleResponseGroups(ctx context.Context, r Rule) ([]Group, error) {
	ids := append([]string{}, r.GroupIDs...)
	if len(ids) == 0 {
		tables, e := m.deps.Catalog(ctx)
		if e != nil {
			return nil, e
		}
		for _, t := range tables {
			if includes(r.SourceTableIDs, t.ID) && t.AlertGroupID != "" {
				ids = append(ids, t.AlertGroupID)
			}
		}
	}
	out := []Group{}
	for _, gid := range uniqueUsers(ids) {
		g, e := m.group(ctx, gid)
		if e == nil && g.Enabled {
			out = append(out, g)
		}
	}
	return out, nil
}
func (m *Module) managedRoute(route Route, groups []Group) bool {
	for _, g := range groups {
		if len(g.Members) > 0 && includes(route.GroupIDs, g.ID) {
			return true
		}
	}
	return false
}
func (m *Module) syncResponsesTx(tx *sql.Tx, event Event, rule Rule, groups []Group) error {
	if event.Kind == "resolved" || event.Kind == "health_resolved" {
		rows, e := tx.Query("SELECT body FROM alert_responses WHERE episode=? AND state<>'resolved'", event.Episode)
		if e != nil {
			return e
		}
		current := []IncidentResponse{}
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
			current = append(current, r)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, r := range current {
			if e = m.startResponseTx(tx, event, rule, r.Group); e != nil {
				return e
			}
		}
		return nil
	}
	for _, g := range groups {
		if e := m.startResponseTx(tx, event, rule, g); e != nil {
			return e
		}
	}
	return nil
}
