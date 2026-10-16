package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func (m *Module) registerResponseAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/notify/channels/{id}/callback-url", m.callbackURL)
	mux.HandleFunc("GET /api/v1/alerts/responders", m.listResponders)
	mux.HandleFunc("GET /api/v1/alerts/policy-defaults", func(w http.ResponseWriter, r *http.Request) { shared.JSON(w, 200, defaultPolicies()) })
	mux.HandleFunc("GET /api/v1/alerts/incidents", m.listIncidents)
	mux.HandleFunc("GET /api/v1/alerts/incidents/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, e := m.response(r.Context(), r.PathValue("id"))
		if e != nil {
			shared.Error(w, 404, "告警事件不存在")
			return
		}
		events, e := listBodies[ResponseAudit](r.Context(), m.deps.DB, "SELECT body FROM alert_response_events WHERE response_id=? ORDER BY at,rowid", v.ID)
		respond(w, map[string]any{"incident": v, "timeline": events}, e)
	})
	mux.HandleFunc("POST /api/v1/alerts/incidents/{id}/ack", func(w http.ResponseWriter, r *http.Request) {
		v, e := m.acknowledge(r.Context(), r.PathValue("id"), shared.CurrentUser(r).ID, "web", m.now())
		if e != nil {
			shared.Error(w, 409, e.Error())
			return
		}
		shared.JSON(w, 200, v)
	})
	mux.HandleFunc("POST /api/v1/alerts/claim", m.claimLink)
	mux.HandleFunc("POST /api/v1/alerts/incidents/{id}/renew", m.renewResponse)
	mux.HandleFunc("POST /api/v1/alerts/incidents/{id}/transfer", m.transferResponse)
	mux.HandleFunc("POST /api/v1/alerts/incidents/{id}/escalate", m.escalateResponse)
	mux.HandleFunc("POST /api/v1/alerts/incidents/{id}/replan", m.replanResponse)
	mux.HandleFunc("POST /api/v1/alerts/groups/{id}/schedule-preview", m.schedulePreview)
	mux.HandleFunc("GET /api/v1/alerts/silences", func(w http.ResponseWriter, r *http.Request) {
		v, e := listBodies[Silence](r.Context(), m.deps.DB, "SELECT body FROM alert_silences ORDER BY rowid DESC")
		respond(w, v, e)
	})
	mux.HandleFunc("POST /api/v1/alerts/silences", m.saveSilence)
	mux.HandleFunc("DELETE /api/v1/alerts/silences/{id}", m.deleteSilence)
	mux.HandleFunc("GET /api/v1/alerts/response-statistics", m.responseStatistics)
	mux.HandleFunc("GET /api/v1/traces/{trace_id}", m.traceDetail)
	m.registerDirectoryAPI(mux)
}
func (m *Module) listResponders(w http.ResponseWriter, r *http.Request) {
	rows, e := m.deps.DB.QueryContext(r.Context(), "SELECT id,name,active FROM users ORDER BY name")
	if e != nil {
		respond(w, nil, e)
		return
	}
	type person struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Active    bool   `json:"active"`
		HasEmail  bool   `json:"has_email"`
		HasPhone  bool   `json:"has_phone"`
		HasFeishu bool   `json:"has_feishu"`
	}
	people := []person{}
	for rows.Next() {
		var p person
		if e = rows.Scan(&p.ID, &p.Name, &p.Active); e != nil {
			rows.Close()
			respond(w, nil, e)
			return
		}
		people = append(people, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		respond(w, nil, e)
		return
	}
	for i, p := range people {
		_, v, _ := m.member(r.Context(), p.ID)
		people[i].HasEmail = v.Email != ""
		people[i].HasPhone = v.Phone != ""
		people[i].HasFeishu = v.FeishuID != ""
	}
	shared.JSON(w, 200, people)
}
func (m *Module) listIncidents(w http.ResponseWriter, r *http.Request) {
	where := "1=1"
	args := []any{}
	for key, col := range map[string]string{"state": "state", "group_id": "group_id"} {
		if v := r.URL.Query().Get(key); v != "" {
			where += " AND " + col + "=?"
			args = append(args, v)
		}
	}
	if v := r.URL.Query().Get("priority"); v != "" {
		where += " AND json_extract(body,'$.priority')=?"
		args = append(args, v)
	}
	v, e := listBodies[IncidentResponse](r.Context(), m.deps.DB, "SELECT body FROM alert_responses WHERE "+where+" ORDER BY created_at DESC LIMIT 500", args...)
	respond(w, v, e)
}
func (m *Module) claimLink(w http.ResponseWriter, r *http.Request) {
	var v struct {
		Token string `json:"token"`
	}
	if shared.Decode(r, &v) != nil || len(v.Token) != 32 {
		shared.Error(w, 400, "无效的接手链接")
		return
	}
	var rid, uid, method, expires string
	if m.deps.DB.QueryRowContext(r.Context(), "SELECT response_id,user_id,method,expires_at FROM alert_claim_tokens WHERE token_hash=?", tokenHash(v.Token)).Scan(&rid, &uid, &method, &expires) != nil || !parse(expires).After(m.now()) {
		shared.Error(w, 410, "接手链接已过期")
		return
	}
	u := shared.CurrentUser(r)
	if uid != "" && uid != u.ID {
		shared.Error(w, 403, "请使用接收此通知的账号登录")
		return
	}
	result, e := m.acknowledge(r.Context(), rid, u.ID, method, m.now())
	if e != nil {
		shared.Error(w, 409, e.Error())
		return
	}
	shared.JSON(w, 200, result)
}
func (m *Module) renewResponse(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, e := m.response(r.Context(), r.PathValue("id"))
	if e != nil {
		shared.Error(w, 404, "事件不存在")
		return
	}
	if v.State != "acknowledged" || v.OwnerID != shared.CurrentUser(r).ID {
		shared.Error(w, 403, "只有当前接手人可以续期")
		return
	}
	seconds := v.Group.policy(v.Priority).HandlingSeconds
	if seconds == 0 {
		seconds = 3600
	}
	v.HandlingUntil = stamp(m.now().Add(time.Duration(seconds) * time.Second))
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	e = saveResponse(tx, v)
	if e == nil {
		e = auditResponse(tx, v, "renewed", v.OwnerID, "web", "确认仍在处理，延长处理期限", m.now())
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, v, e)
}
func (m *Module) transferResponse(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var body struct {
		UserID string `json:"user_id"`
	}
	if shared.Decode(r, &body) != nil {
		shared.Error(w, 400, "无效的接手人")
		return
	}
	v, e := m.response(r.Context(), r.PathValue("id"))
	if e != nil {
		shared.Error(w, 404, "事件不存在")
		return
	}
	if v.State == "resolved" || v.State == "cancelled" || !(v.OwnerID == shared.CurrentUser(r).ID || shared.IsAdmin(r)) {
		shared.Error(w, 403, "当前接手人或管理员可以转交")
		return
	}
	g, e := m.group(r.Context(), v.GroupID)
	if e != nil || !includes(g.Members, body.UserID) {
		shared.Error(w, 400, "转交人必须为组成员")
		return
	}
	name, _, ok := m.member(r.Context(), body.UserID)
	if !ok {
		shared.Error(w, 400, "接手人已停用")
		return
	}
	v.State = "unclaimed"
	v.OwnerID = ""
	v.OwnerName = ""
	v.AckAt = ""
	v.AckMethod = ""
	v.HandlingUntil = ""
	v.Group.Fallback = []string{body.UserID}
	v.Stage = "fallback"
	v.Exhausted = false
	v.Round = 0
	v.StageRound = 0
	v.SuccessfulRounds = 0
	v.ActiveSeconds = 0
	v.LevelActiveSeconds = 0
	v.CountedRound = 0
	v.SinceRoundSeconds = 0
	v.LastTick = stamp(m.now())
	v.Generation++
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	e = saveResponse(tx, v)
	if e == nil {
		_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", v.ID)
	}
	if e == nil {
		e = auditResponse(tx, v, "transfer", shared.CurrentUser(r).ID, "web", "转交给"+name+"，等待其接手", m.now())
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, v, e)
}
func (m *Module) escalateResponse(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, e := m.response(r.Context(), r.PathValue("id"))
	if e != nil {
		shared.Error(w, 404, "事件不存在")
		return
	}
	if !m.canRespond(r.Context(), v, shared.CurrentUser(r)) || v.State == "resolved" || v.State == "cancelled" {
		shared.Error(w, 403, "没有响应权限或事件已恢复")
		return
	}
	v.State = "unclaimed"
	v.OwnerID = ""
	v.OwnerName = ""
	v.AckAt = ""
	v.AckMethod = ""
	v.HandlingUntil = ""
	v.Exhausted = false
	v.Round = 0
	v.StageRound = 0
	v.SuccessfulRounds = 0
	v.CountedRound = 0
	v.LevelActiveSeconds = 0
	v.SinceRoundSeconds = 0
	v.LastTick = stamp(m.now())
	v.Generation++
	if v.Stage == "primary" {
		v.Stage = "backup"
	} else {
		v.Stage = "fallback"
	}
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	e = saveResponse(tx, v)
	if e == nil {
		e = auditResponse(tx, v, "manual_escalation", shared.CurrentUser(r).ID, "web", "主动通知"+v.Stage, m.now())
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, v, e)
}
func (m *Module) replanResponse(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	v, e := m.response(r.Context(), r.PathValue("id"))
	if e != nil {
		shared.Error(w, 404, "事件不存在")
		return
	}
	if v.State == "resolved" || v.State == "cancelled" {
		shared.Error(w, 409, "已结束事件不能重新规划")
		return
	}
	g, e := m.group(r.Context(), v.GroupID)
	if e != nil || !g.Enabled || len(g.Members) == 0 {
		shared.Error(w, 409, "当前责任组不可用")
		return
	}
	v.Group, v.GroupName = g, g.Name
	v.Generation++
	v.Stage, v.Round, v.StageRound = "primary", 0, 0
	v.SuccessfulRounds, v.CountedRound = 0, 0
	v.LevelActiveSeconds, v.SinceRoundSeconds = 0, 0
	v.NightPeriod, v.NightCount, v.NightLastRoundAt, v.NightEligibleAt = "", 0, "", ""
	v.Exhausted, v.DeferredReason = false, ""
	v.LastTick = stamp(m.now())
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	e = saveResponse(tx, v)
	if e == nil {
		_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", v.ID)
	}
	if e == nil {
		e = auditResponse(tx, v, "replanned", shared.CurrentUser(r).ID, "web", "应用当前责任组配置，保留接手人与历史通知", m.now())
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, v, e)
}
func (m *Module) schedulePreview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Group *Group `json:"group"`
		From  string `json:"from"`
		Days  int    `json:"days"`
	}
	if shared.Decode(r, &body) != nil {
		shared.Error(w, 400, "无效的预览")
		return
	}
	g, e := m.group(r.Context(), r.PathValue("id"))
	if body.Group != nil {
		g = *body.Group
		e = nil
	}
	if e != nil {
		shared.Error(w, 404, "告警组不存在")
		return
	}
	if e = m.validateGroupResponse(r.Context(), &g); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	from := parse(body.From)
	if from.IsZero() {
		from = m.now()
	}
	if body.Days < 1 {
		body.Days = 14
	}
	if body.Days > 90 {
		body.Days = 90
	}
	loc, _ := time.LoadLocation(g.Timezone)
	n := from.In(loc)
	out := []map[string]any{}
	for i := 0; i < body.Days; i++ {
		at := n.AddDate(0, 0, i)
		shift := g.onCall(at)
		out = append(out, map[string]any{"at": stamp(at), "date": at.Format("2006-01-02"), "primary": shift.Primary, "backup": shift.Backup, "coverage_gap": len(m.activeMembers(r.Context(), shift.Primary)) == 0})
	}
	shared.JSON(w, 200, out)
}
func (m *Module) silencePermission(ctx context.Context, s Silence, u shared.User) bool {
	if u.Role == "admin" || s.CreatedBy == u.ID {
		return true
	}
	if s.Scope == "group" {
		g, e := m.group(ctx, s.GroupID)
		return e == nil && includes(g.Members, u.ID)
	}
	if s.Scope == "incident" {
		v, e := m.response(ctx, s.ResponseID)
		return e == nil && m.canRespond(ctx, v, u)
	}
	return false
}
func (m *Module) saveSilence(w http.ResponseWriter, r *http.Request) {
	var s Silence
	if shared.Decode(r, &s) != nil {
		shared.Error(w, 400, "无效的静默")
		return
	}
	// Do not trust a supplied created_by value to confer permission.
	s.CreatedBy = ""
	if !m.silencePermission(r.Context(), s, shared.CurrentUser(r)) {
		shared.Error(w, 403, "没有此范围的静默权限")
		return
	}
	if !includes([]string{"all", "group", "rule", "incident", "service"}, s.Scope) {
		shared.Error(w, 400, "无效的静默范围")
		return
	}
	if s.Timezone == "" {
		s.Timezone = "Asia/Shanghai"
	}
	if _, e := time.LoadLocation(s.Timezone); e != nil {
		shared.Error(w, 400, "无效的时区")
		return
	}
	if s.From == "" {
		s.From = stamp(m.now())
	}
	if parse(s.From).IsZero() {
		shared.Error(w, 400, "无效的开始时间")
		return
	}
	if s.DailyStart != "" {
		if _, e := clockMinutes(s.DailyStart); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		if _, e := clockMinutes(s.DailyEnd); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
	}
	if (s.Until == "" && s.DailyStart == "") || (s.Until != "" && !parse(s.Until).After(parse(s.From))) {
		shared.Error(w, 400, "静默结束时间必须晚于开始时间")
		return
	}
	if (s.Scope == "group" && s.GroupID == "") || (s.Scope == "rule" && s.RuleID == "") || (s.Scope == "incident" && s.ResponseID == "") || (s.Scope == "service" && s.Service == "") {
		shared.Error(w, 400, "静默范围缺少目标")
		return
	}
	for _, day := range s.Weekdays {
		if day < 0 || day > 6 {
			shared.Error(w, 400, "无效的星期")
			return
		}
	}
	for _, p := range s.Priorities {
		if priority(p) != p {
			shared.Error(w, 400, "无效的告警级别")
			return
		}
	}
	s.ID = id()
	s.CreatedBy = shared.CurrentUser(r).ID
	if s.Reason == "" {
		s.Reason = "临时静默"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, e := m.deps.DB.ExecContext(r.Context(), "INSERT INTO alert_silences(id,body) VALUES(?,?)", s.ID, encode(s))
	respond(w, s, e)
}
func (m *Module) deleteSilence(w http.ResponseWriter, r *http.Request) {
	var raw string
	if m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_silences WHERE id=?", r.PathValue("id")).Scan(&raw) != nil {
		shared.Error(w, 404, "静默不存在")
		return
	}
	var s Silence
	_ = json.Unmarshal([]byte(raw), &s)
	if !m.silencePermission(r.Context(), s, shared.CurrentUser(r)) {
		shared.Error(w, 403, "没有结束此静默的权限")
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s.Until = stamp(m.now())
	_, e := m.deps.DB.ExecContext(r.Context(), "UPDATE alert_silences SET body=? WHERE id=?", encode(s), s.ID)
	respond(w, map[string]bool{"ok": true}, e)
}

type UserResponseStatistics struct {
	UserID           string         `json:"user_id"`
	UserName         string         `json:"user_name"`
	Notified         int            `json:"notified"`
	Acknowledged     int            `json:"acknowledged"`
	PeerClaimed      int            `json:"peer_claimed"`
	Recovered        int            `json:"recovered"`
	Cancelled        int            `json:"cancelled"`
	Pending          int            `json:"pending"`
	AckRate          float64        `json:"ack_rate"`
	MeanAckSeconds   float64        `json:"mean_ack_seconds"`
	MedianAckSeconds float64        `json:"median_ack_seconds"`
	P95AckSeconds    float64        `json:"p95_ack_seconds"`
	Methods          map[string]int `json:"methods"`
	Priorities       map[string]int `json:"priorities"`
	durations        []float64
}

func (m *Module) responseStatistics(w http.ResponseWriter, r *http.Request) {
	from, to := parse(r.URL.Query().Get("from")), parse(r.URL.Query().Get("to"))
	if from.IsZero() {
		from = m.now().AddDate(0, 0, -30)
	}
	if to.IsZero() {
		to = m.now().Add(time.Second)
	}
	if !to.After(from) {
		shared.Error(w, 400, "统计结束时间必须晚于开始时间")
		return
	}
	where := "a.notified_at>=? AND a.notified_at<?"
	args := []any{stamp(from), stamp(to)}
	if v := r.URL.Query().Get("group_id"); v != "" {
		where += " AND i.group_id=?"
		args = append(args, v)
	}
	if v := r.URL.Query().Get("priority"); v != "" {
		where += " AND a.priority=?"
		args = append(args, v)
	}
	rows, e := m.deps.DB.QueryContext(r.Context(), `SELECT a.response_id,a.user_id,a.user_name,a.stage,a.priority,a.notified_at,a.ack_at,a.ack_method,a.outcome,i.body FROM alert_assignments a JOIN alert_responses i ON i.id=a.response_id WHERE `+where+` ORDER BY a.notified_at DESC LIMIT 20000`, args...)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer rows.Close()
	users := map[string]*UserResponseStatistics{}
	records := []map[string]any{}
	for rows.Next() {
		var rid, uid, name, stage, p, notified, ack, method, outcome, raw string
		if e = rows.Scan(&rid, &uid, &name, &stage, &p, &notified, &ack, &method, &outcome, &raw); e != nil {
			respond(w, nil, e)
			return
		}
		var incident IncidentResponse
		_ = json.Unmarshal([]byte(raw), &incident)
		v := users[uid]
		if v == nil {
			v = &UserResponseStatistics{UserID: uid, UserName: name, Methods: map[string]int{}, Priorities: map[string]int{}}
			users[uid] = v
		}
		v.Notified++
		v.Priorities[p]++
		seconds := 0.0
		if ack != "" {
			v.Acknowledged++
			v.Methods[method]++
			seconds = parse(ack).Sub(parse(notified)).Seconds()
			if seconds < 0 {
				seconds = 0
			}
			v.durations = append(v.durations, seconds)
			v.MeanAckSeconds += seconds
		} else {
			switch outcome {
			case "peer_claimed":
				v.PeerClaimed++
			case "recovered":
				v.Recovered++
			case "cancelled":
				v.Cancelled++
			default:
				v.Pending++
			}
		}
		records = append(records, map[string]any{"response_id": rid, "user_id": uid, "user_name": name, "group_id": incident.GroupID, "group_name": incident.GroupName, "rule_id": incident.RuleID, "rule_name": incident.Event.RuleName, "source_priority": incident.OriginalPriority, "priority": p, "stage": stage, "notified_at": notified, "ack_at": ack, "ack_method": method, "outcome": outcome, "ack_seconds": seconds})
	}
	if e = rows.Err(); e != nil {
		respond(w, nil, e)
		return
	}
	rows.Close()
	zeroMembers := []string{}
	if gid := r.URL.Query().Get("group_id"); gid != "" {
		g, e := m.group(r.Context(), gid)
		if e == nil {
			zeroMembers = g.Members
		}
	} else {
		people, e := m.deps.DB.QueryContext(r.Context(), "SELECT id,name FROM users WHERE active=1")
		if e != nil {
			respond(w, nil, e)
			return
		}
		for people.Next() {
			var uid, name string
			if e = people.Scan(&uid, &name); e != nil {
				people.Close()
				respond(w, nil, e)
				return
			}
			if users[uid] == nil {
				users[uid] = &UserResponseStatistics{UserID: uid, UserName: name, Methods: map[string]int{}, Priorities: map[string]int{}}
			}
		}
		people.Close()
	}
	for _, uid := range zeroMembers {
		if users[uid] != nil {
			continue
		}
		name, _, ok := m.member(r.Context(), uid)
		if ok {
			users[uid] = &UserResponseStatistics{UserID: uid, UserName: name, Methods: map[string]int{}, Priorities: map[string]int{}}
		}
	}
	out := []*UserResponseStatistics{}
	for _, v := range users {
		if v.Notified > 0 {
			v.AckRate = float64(v.Acknowledged) * 100 / float64(v.Notified)
		}
		if v.Acknowledged > 0 {
			v.MeanAckSeconds /= float64(v.Acknowledged)
			sort.Float64s(v.durations)
			middle := len(v.durations) / 2
			v.MedianAckSeconds = v.durations[middle]
			if len(v.durations)%2 == 0 {
				v.MedianAckSeconds = (v.durations[middle-1] + v.durations[middle]) / 2
			}
			idx := (len(v.durations)*95+99)/100 - 1
			if idx < 0 {
				idx = 0
			}
			v.P95AckSeconds = v.durations[idx]
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UserName < out[j].UserName })
	shared.JSON(w, 200, map[string]any{"from": stamp(from), "to": stamp(to), "users": out, "records": records, "truncated": len(records) == 20000, "definition": "接手率=本人接手告警数/实际通知本人的不同组告警数；多渠道与重试去重。接手时长从首次通知受理到接手。其他人接手与自动恢复单独列示。"})
}

// Validate statically declared local sources before a rule can start querying them.
func (m *Module) validateEvidenceProfile(ctx context.Context, p *EvidenceProfile) error {
	if p == nil {
		return nil
	}
	tables, e := m.deps.Catalog(ctx)
	if e != nil {
		return e
	}
	known := map[string]shared.Table{}
	for _, t := range tables {
		known[t.ID] = t
	}
	if p.LogTableID != "" {
		t, ok := known[p.LogTableID]
		if !ok || t.Kind != "log" {
			return fmt.Errorf("现场日志表必须为日志类型")
		}
	}
	if len(p.TraceTableIDs) > 8 || len(p.LabelMappings) > 16 || p.LookbackSeconds < 0 || p.LookbackSeconds > 3600 {
		return fmt.Errorf("现场取证范围超限")
	}
	for _, tid := range p.TraceTableIDs {
		t, ok := known[tid]
		if !ok || t.Kind != "trace" {
			return fmt.Errorf("关联trace表必须为trace类型")
		}
	}
	return nil
}
