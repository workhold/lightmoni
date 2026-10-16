package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	"math/big"
	"net/http"
	"net/mail"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (m *Module) Register(mux *http.ServeMux) {
	m.registerResponseAPI(mux)
	mux.HandleFunc("GET /api/v1/alerts/groups", func(w http.ResponseWriter, r *http.Request) { v, e := m.groups(r.Context()); respond(w, v, e) })
	mux.HandleFunc("POST /api/v1/alerts/groups", m.saveGroup)
	mux.HandleFunc("PUT /api/v1/alerts/groups/{id}", m.saveGroup)
	mux.HandleFunc("DELETE /api/v1/alerts/groups/{id}", m.deleteGroup)
	mux.HandleFunc("GET /api/v1/notify/channels", func(w http.ResponseWriter, r *http.Request) {
		v, e := listBodies[Channel](r.Context(), m.deps.DB, "SELECT body FROM alert_channels ORDER BY name")
		respond(w, v, e)
	})
	mux.HandleFunc("POST /api/v1/notify/channels", m.saveChannel)
	mux.HandleFunc("PUT /api/v1/notify/channels/{id}", m.saveChannel)
	mux.HandleFunc("DELETE /api/v1/notify/channels/{id}", m.deleteChannel)
	mux.HandleFunc("POST /api/v1/notify/channels/{id}/test", m.testChannel)
	mux.HandleFunc("GET /api/v1/alerts/rules", m.listRules)
	mux.HandleFunc("POST /api/v1/alerts/rules", m.saveRule)
	mux.HandleFunc("PUT /api/v1/alerts/rules/{id}", m.saveRule)
	mux.HandleFunc("DELETE /api/v1/alerts/rules/{id}", m.deleteRule)
	mux.HandleFunc("POST /api/v1/alerts/preview", m.preview)
	mux.HandleFunc("GET /api/v1/alerts/tables", m.listTables)
	mux.HandleFunc("GET /api/v1/alerts/instances", func(w http.ResponseWriter, r *http.Request) {
		v, e := listBodies[State](r.Context(), m.deps.DB, "SELECT body FROM alert_states ORDER BY rule_id")
		if e != nil {
			respond(w, nil, e)
			return
		}
		out := []State{}
		rules, _ := m.rules(r.Context())
		allowed := m.filteredIDs(r, rules)
		for _, s := range v {
			if allowed[s.RuleID] {
				out = append(out, s)
			}
		}
		respond(w, out, nil)
	})
	mux.HandleFunc("GET /api/v1/alerts/events", m.listEvents)
	mux.HandleFunc("GET /api/v1/alerts/annotations", m.annotations)
	mux.HandleFunc("GET /api/v1/notify/deliveries", m.listDeliveries)
	mux.HandleFunc("POST /api/v1/notify/deliveries/{id}/retry", m.retryDelivery)
	mux.HandleFunc("POST /api/v1/alerts/rules/{id}/silence", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		var v struct {
			Until string `json:"until"`
		}
		if shared.Decode(r, &v) != nil || (v.Until != "" && parse(v.Until).IsZero()) {
			shared.Error(w, 400, "invalid silence end")
			return
		}
		var raw string
		if m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_rules WHERE id=?", r.PathValue("id")).Scan(&raw) != nil {
			shared.Error(w, 404, "rule not found")
			return
		}
		var rule Rule
		_ = json.Unmarshal([]byte(raw), &rule)
		rule.SilenceUntil = v.Until
		rule.Revision++
		states, e := listBodies[State](r.Context(), m.deps.DB, "SELECT body FROM alert_states WHERE rule_id=?", rule.ID)
		if e != nil {
			respond(w, nil, e)
			return
		}
		tx, e := m.deps.DB.BeginTx(r.Context(), nil)
		if e != nil {
			respond(w, nil, e)
			return
		}
		defer tx.Rollback()
		_, e = tx.Exec("UPDATE alert_rules SET body=? WHERE id=?", encode(rule), rule.ID)
		if parse(v.Until).After(m.now()) {
			if e == nil {
				_, e = tx.Exec("UPDATE alert_outbox SET status='suppressed' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)", rule.ID)
			}
			for _, s := range states {
				if e != nil {
					break
				}
				s.Silenced = true
				_, e = tx.Exec("UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?", encode(s), rule.ID, s.Fingerprint)
			}
		}
		if e == nil {
			e = tx.Commit()
		}
		respond(w, rule, e)
	})
}
func respond(w http.ResponseWriter, v any, e error) {
	if e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	shared.JSON(w, 200, v)
}
func admin(w http.ResponseWriter, r *http.Request) bool {
	if !shared.IsAdmin(r) {
		shared.Error(w, 403, "通知凭证配置需要管理员权限")
		return false
	}
	return true
}
func (m *Module) saveGroup(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var g Group
	if e := shared.Decode(r, &g); e != nil {
		shared.Error(w, 400, "invalid group")
		return
	}
	g.Name = strings.TrimSpace(g.Name)
	if r.Method == http.MethodPost && len(g.Members) > 0 && len(g.Policies) == 0 {
		g.Policies = defaultPolicies()
	}
	if e := m.validateGroupResponse(r.Context(), &g); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	if g.Name == "" {
		shared.Error(w, 400, "告警组名称不能为空")
		return
	}
	if len(g.Targets) > 100 {
		shared.Error(w, 400, "最多100个通知目标")
		return
	}
	seen := map[string]bool{}
	for i := range g.Targets {
		t := &g.Targets[i]
		c, e := m.channel(r.Context(), t.ChannelID, false)
		if e != nil {
			shared.Error(w, 400, "通知渠道不存在")
			return
		}
		if e = validateRecipient(c.Type, &t.Recipient); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		key := t.ChannelID + recipientKey(t.Recipient)
		if seen[key] {
			shared.Error(w, 400, "重复通知目标")
			return
		}
		seen[key] = true
	}
	g.ID = r.PathValue("id")
	if g.ID == "" {
		g.ID = id()
	}
	var oldRaw string
	var old Group
	_ = m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_groups WHERE id=?", g.ID).Scan(&oldRaw)
	_ = json.Unmarshal([]byte(oldRaw), &old)
	if old.ID != "" && old.Revision != g.Revision {
		shared.Error(w, 409, "告警组已更新，请刷新后重试")
		return
	}
	g.Revision = old.Revision + 1
	_, e := m.deps.DB.ExecContext(r.Context(), "INSERT INTO alert_groups(id,name,body) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body", g.ID, g.Name, encode(g))
	respond(w, g, e)
}
func validateRecipient(typ string, p *Recipient) error {
	p.Value = strings.TrimSpace(p.Value)
	sort.Strings(p.Mentions)
	switch typ {
	case "feishu_app":
		if p.Kind != "feishu_user" || p.Value == "" {
			return errors.New("飞书企业应用目标需要用户open_id")
		}
	case "smtp":
		if p.Kind != "email" {
			return errors.New("SMTP目标必须是邮箱")
		}
		a, e := mail.ParseAddress(p.Value)
		if e != nil {
			return errors.New("invalid email")
		}
		p.Value = a.Address
	case "aliyun_sms", "aliyun_voice", "tencent_sms", "tencent_voice", "huawei_sms":
		if p.Kind != "phone" || len(p.Value) < 8 || strings.ContainsAny(p.Value, " ,\r\n") {
			return errors.New("短信/电话目标必须是单个号码")
		}
		for i, c := range p.Value {
			if c < '0' || c > '9' {
				if i != 0 || c != '+' {
					return errors.New("invalid phone")
				}
			}
		}
		if len(strings.TrimPrefix(p.Value, "+")) > 15 {
			return errors.New("号码不能超过15位")
		}
		if typ == "tencent_sms" || typ == "tencent_voice" || typ == "huawei_sms" {
			phone, e := internationalPhone(p.Value)
			if e != nil {
				return e
			}
			p.Value = phone
		} else if strings.HasPrefix(p.Value, "+86") && len(p.Value) == 14 {
			p.Value = strings.TrimPrefix(p.Value, "+86")
		}
	case "pushplus":
		if p.Kind != "self" && p.Kind != "topic" && p.Kind != "friend" {
			return errors.New("pushplus目标必须是self/topic/friend")
		}
		if p.Kind != "self" && p.Value == "" {
			return errors.New("推送绑定目标不能为空")
		}
	default:
		if p.Kind != "channel" {
			return errors.New("机器人/Webhook使用channel目标")
		}
		p.Value = "bound"
	}
	return nil
}
func (m *Module) deleteGroup(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tables, e := m.deps.Catalog(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	for _, t := range tables {
		if t.AlertGroupID == r.PathValue("id") {
			shared.Error(w, 409, "请先解除数据表的告警组绑定")
			return
		}
	}
	rules, e := m.rules(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	for _, rule := range rules {
		if includes(rule.GroupIDs, r.PathValue("id")) {
			shared.Error(w, 409, "请先解除图表或告警规则的告警组绑定")
			return
		}
	}
	_, e = m.deps.DB.ExecContext(r.Context(), "DELETE FROM alert_groups WHERE id=?", r.PathValue("id"))
	respond(w, map[string]bool{"ok": true}, e)
}

var secretFields = map[string]bool{"url": true, "secret": true, "token": true, "password": true, "access_key": true, "access_key_id": true, "access_key_secret": true, "headers": true, "secret_id": true, "secret_key": true, "app_key": true, "app_secret": true, "callback_token": true, "verification_token": true, "encrypt_key": true}
var channelTypes = map[string]bool{"webhook": true, "feishu": true, "feishu_app": true, "dingtalk": true, "wecom": true, "pushplus": true, "smtp": true, "aliyun_sms": true, "aliyun_voice": true, "tencent_sms": true, "tencent_voice": true, "huawei_sms": true}

func (m *Module) saveChannel(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !admin(w, r) {
		return
	}
	var c Channel
	if shared.Decode(r, &c) != nil || strings.TrimSpace(c.Name) == "" || !channelTypes[c.Type] {
		shared.Error(w, 400, "invalid notification channel")
		return
	}
	c.ID = r.PathValue("id")
	if c.ID == "" {
		c.ID = id()
	}
	old, _ := m.channel(r.Context(), c.ID, true)
	if old.ID != "" && old.Revision != c.Revision {
		shared.Error(w, 409, "通知渠道已更新，请刷新后重试")
		return
	}
	c.Revision = old.Revision + 1
	if c.Config == nil {
		c.Config = map[string]string{}
	}
	sec := map[string]string{}
	for k, v := range old.Config {
		if old.Type == c.Type && secretFields[k] {
			sec[k] = v
		}
	}
	for k, v := range c.Config {
		if secretFields[k] {
			if v != "" {
				sec[k] = v
			}
			delete(c.Config, k)
		}
	}
	combined := map[string]string{}
	for k, v := range c.Config {
		combined[k] = v
	}
	for k, v := range sec {
		combined[k] = v
	}
	if (c.Type == "aliyun_voice" || c.Type == "tencent_voice" || c.Type == "feishu_app") && sec["callback_token"] == "" {
		sec["callback_token"] = id() + id()
		combined["callback_token"] = sec["callback_token"]
	}
	if e := validateChannel(c.Type, combined); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	cipher, e := m.deps.Encrypt(encode(sec))
	if e != nil {
		respond(w, nil, e)
		return
	}
	c.HasSecret = len(sec) > 0
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	_, e = tx.Exec("INSERT INTO alert_channels(id,name,body,secret) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body,secret=excluded.secret", c.ID, c.Name, encode(c), cipher)
	changedDestination := old.ID != "" && old.Type != c.Type
	for _, key := range []string{"url", "endpoint", "token", "push_channel", "host", "port", "tls", "username", "from", "access_key_id", "access_key_secret", "secret_id", "secret_key", "app_key", "app_secret", "sdk_app_id", "region", "sign_name", "template_code", "template_id", "template_params", "called_show_number", "sender", "signature", "play_times"} {
		changedDestination = changedDestination || old.ID != "" && old.Config[key] != combined[key]
	}
	if e == nil && (changedDestination || !c.Enabled) {
		_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE channel_id=? AND status IN ('queued','retry')", c.ID)
	}
	if e == nil {
		_, e = tx.Exec("DELETE FROM alert_rate_blocks WHERE rate_key=? OR rate_key=?", rateKey(old), rateKey(Channel{Type: c.Type, Config: combined}))
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, c, e)
}
func validateChannel(typ string, c map[string]string) error {
	if value := c["rate_per_minute"]; value != "" {
		rate, e := strconv.Atoi(value)
		if e != nil || rate < 1 || rate >= 600 {
			return errors.New("每分钟发送上限必须在1到599之间")
		}
	}
	if endpoint := c["endpoint"]; endpoint != "" {
		u, e := url.Parse(endpoint)
		if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
			return errors.New("接口地址必须是有效的HTTP(S)地址")
		}
		if (typ == "tencent_sms" || typ == "tencent_voice") && ((u.Path != "" && u.Path != "/") || u.RawQuery != "") {
			return errors.New("腾讯云接口地址必须使用根路径且不含查询参数")
		}
	}
	switch typ {
	case "smtp":
		if c["host"] == "" || c["from"] == "" {
			return errors.New("SMTP requires host and from")
		}
		if _, e := mail.ParseAddress(c["from"]); e != nil {
			return errors.New("invalid sender")
		}
		if c["tls"] != "starttls" && c["tls"] != "tls" && c["tls"] != "none" {
			return errors.New("SMTP TLS mode is starttls/tls/none")
		}
		if c["port"] != "" {
			port, e := strconv.Atoi(c["port"])
			if e != nil || port < 1 || port > 65535 {
				return errors.New("SMTP端口必须在1到65535之间")
			}
		}
	case "aliyun_sms":
		for _, k := range []string{"access_key_id", "access_key_secret", "sign_name", "template_code"} {
			if c[k] == "" {
				return fmt.Errorf("SMS requires %s", k)
			}
		}
		return validateTemplateParams(c["template_params"], false)
	case "feishu_app":
		if c["app_id"] == "" || c["app_secret"] == "" || c["verification_token"] == "" {
			return errors.New("飞书企业应用需要App ID、App Secret和Verification Token")
		}
		if base := c["api_base"]; base != "" {
			u, e := url.Parse(base)
			if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
				return errors.New("无效的飞书API地址")
			}
		}
	case "aliyun_voice", "tencent_sms", "tencent_voice", "huawei_sms":
		return validatePhoneChannel(typ, c)
	case "pushplus":
		if c["token"] == "" {
			return errors.New("pushplus token required")
		}
		if c["push_channel"] != "wechat" && c["push_channel"] != "app" {
			return errors.New("pushplus channel is wechat or app")
		}
	default:
		u, e := url.Parse(c["url"])
		if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return errors.New("valid http(s) webhook URL required")
		}
	}
	return nil
}
func (m *Module) deleteChannel(w http.ResponseWriter, r *http.Request) {
	if !admin(w, r) {
		return
	}
	gs, e := m.groups(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	for _, g := range gs {
		if includes(g.ChannelIDs, r.PathValue("id")) {
			shared.Error(w, 409, "请先解除告警组中的通知接入引用")
			return
		}
		for _, t := range g.Targets {
			if t.ChannelID == r.PathValue("id") {
				shared.Error(w, 409, "请先移除告警组中的渠道目标")
				return
			}
		}
	}
	_, e = m.deps.DB.ExecContext(r.Context(), "DELETE FROM alert_channels WHERE id=?", r.PathValue("id"))
	respond(w, map[string]bool{"ok": true}, e)
}
func (m *Module) validateRule(ctx context.Context, v *Rule) error {
	if v.EvidenceProfile == nil {
		m.autoEvidenceProfile(ctx, v)
	}
	if v.Severity != "" && !includes([]string{"P0", "P1", "P2", "P3", "warning", "critical"}, v.Severity) {
		return errors.New("告警级别必须为P0至P3")
	}
	v.Severity = priority(v.Severity)
	if e := m.validateEvidenceProfile(ctx, v.EvidenceProfile); e != nil {
		return e
	}
	if v.Kind != "metric" && v.Kind != "sql" && v.Kind != "log" {
		return errors.New("invalid alert kind")
	}
	if strings.TrimSpace(v.Name) == "" || strings.TrimSpace(v.SQL) == "" || v.ValueField == "" {
		return errors.New("name, SQL and value field required")
	}
	if _, ok := new(big.Rat).SetString(v.Threshold); !ok {
		return errors.New("threshold must be a finite number")
	}
	if v.Operator != "gt" && v.Operator != "gte" && v.Operator != "lt" && v.Operator != "lte" && v.Operator != "eq" && v.Operator != "ne" && v.Operator != "no_data" {
		return errors.New("invalid operator")
	}
	if v.IntervalSeconds < 1 || v.IntervalSeconds > 86400 || v.WindowSeconds < 1 || v.WindowSeconds > 604800 || v.ForSeconds < 0 || v.RecoverySeconds < 0 || v.DelaySeconds < 0 || v.HealthForSeconds < 0 || v.RepeatSeconds < 0 {
		return errors.New("invalid evaluation/window duration")
	}
	if v.ForCount < 0 || v.ForCount > 1000 {
		return errors.New("连续异常检测次数必须为1到1000")
	}
	if v.ForCount == 0 { // Existing rules omitted this field.
		v.ForCount = 1
	}
	switch v.NoDataPolicy {
	case "", "keep_state", "zero", "alerting", "normal":
	case "value":
		if v.Operator != "no_data" {
			if _, ok := new(big.Rat).SetString(v.NoDataValue); !ok {
				return errors.New("无数据替代值必须为有限数值")
			}
		}
	default:
		return errors.New("invalid no-data policy")
	}
	if v.PanelCondition != nil {
		switch v.PanelCondition.Reducer {
		case "last", "avg", "max", "min", "sum", "count":
		default:
			return errors.New("invalid panel reducer")
		}
	}
	refs, e := m.deps.ReferencedTables(ctx, v.SQL)
	if e != nil {
		return e
	}
	tables, e := m.deps.Catalog(ctx)
	if e != nil {
		return e
	}
	names := map[string]string{}
	for _, t := range tables {
		names[t.Name] = t.ID
	}
	actual := []string{}
	for _, n := range refs {
		tid, ok := names[n]
		if !ok {
			return errors.New("SQL reads unknown table")
		}
		actual = append(actual, tid)
	}
	sort.Strings(actual)
	declared := append([]string{}, v.SourceTableIDs...)
	sort.Strings(declared)
	if len(actual) == 0 || strings.Join(actual, "\n") != strings.Join(declared, "\n") {
		return fmt.Errorf("source_table_ids must match SQL AST tables: %v", actual)
	}
	if len(v.LabelFields) > 10 {
		return errors.New("too many label fields")
	}
	if len(v.GroupIDs) > 16 {
		return errors.New("最多绑定 16 个告警组")
	}
	groups, e := m.groups(ctx)
	if e != nil {
		return e
	}
	seen := map[string]bool{}
	for _, gid := range v.GroupIDs {
		found := false
		for _, group := range groups {
			if group.ID == gid && gid != "" {
				found = true
			}
		}
		if !found || seen[gid] {
			return errors.New("请选择有效且不重复的告警组")
		}
		seen[gid] = true
	}
	return nil
}
func (m *Module) saveRule(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var v Rule
	if shared.Decode(r, &v) != nil {
		shared.Error(w, 400, "invalid rule")
		return
	}
	if e := m.validateRule(r.Context(), &v); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	v.ID = r.PathValue("id")
	if v.ID == "" {
		v.ID = id()
	}
	var oldRaw string
	var old Rule
	_ = m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_rules WHERE id=?", v.ID).Scan(&oldRaw)
	_ = json.Unmarshal([]byte(oldRaw), &old)
	if old.ID != "" && old.Revision != v.Revision {
		shared.Error(w, 409, "告警规则已更新，请刷新后重试")
		return
	}
	v.Revision = old.Revision + 1
	measurementChanged := old.ID == "" || ruleMeasurement(old) != ruleMeasurement(v)
	states := []State{}
	if !measurementChanged && old.Enabled != v.Enabled {
		var err error
		states, err = listBodies[State](r.Context(), m.deps.DB, "SELECT body FROM alert_states WHERE rule_id=?", v.ID)
		if err != nil {
			respond(w, nil, err)
			return
		}
	}
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	_, e = tx.Exec("INSERT INTO alert_rules(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,last_eval=''", v.ID, encode(v))
	if e == nil && measurementChanged {
		_, e = tx.Exec("DELETE FROM alert_states WHERE rule_id=?", v.ID)
	}
	for _, s := range states {
		if e != nil {
			break
		}
		if s.Status == "pending" {
			s.Status = "normal"
		}
		if s.Status == "recovering" {
			s.Status = "firing"
		}
		s.Since = ""
		s.LastEval = ""
		s.ConsecutiveFailures = 0
		if s.Health != "ok" {
			s.HealthSince = stamp(m.now())
		}
		_, e = tx.Exec("UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?", encode(s), v.ID, s.Fingerprint)
	}
	if e == nil && (measurementChanged || !v.Enabled) {
		reason := "规则判断已变更"
		if !v.Enabled {
			reason = "规则已禁用"
		}
		e = m.cancelRuleResponsesTx(tx, v.ID, reason)
	}
	if e == nil && (measurementChanged || !v.Enabled) {
		_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)", v.ID)
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, v, e)
}
func ruleMeasurement(r Rule) string {
	r.ForCount = max(1, r.ForCount)
	r.ID = ""
	r.Revision = 0
	r.Name = ""
	r.Enabled = false
	r.Severity = ""
	r.Unit = ""
	r.RepeatSeconds = 0
	r.SilenceUntil = ""
	r.EvidenceProfile = nil
	return encode(r)
}
func (m *Module) deleteRule(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, e := m.deps.DB.BeginTx(r.Context(), nil)
	if e != nil {
		respond(w, nil, e)
		return
	}
	defer tx.Rollback()
	_, e = tx.Exec("DELETE FROM alert_rules WHERE id=?", r.PathValue("id"))
	if e == nil {
		e = m.cancelRuleResponsesTx(tx, r.PathValue("id"), "规则已删除")
	}
	if e == nil {
		_, e = tx.Exec("DELETE FROM alert_states WHERE rule_id=?", r.PathValue("id"))
	}
	if e == nil {
		_, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND event_id IN (SELECT id FROM alert_events WHERE rule_id=?)", r.PathValue("id"))
	}
	if e == nil {
		e = tx.Commit()
	}
	respond(w, map[string]bool{"ok": true}, e)
}
func includes(v []string, s string) bool {
	if s == "" {
		return true
	}
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}
func (m *Module) filteredIDs(req *http.Request, rules []Rule) map[string]bool {
	out := map[string]bool{}
	q := req.URL.Query()
	tables, _ := m.deps.Catalog(req.Context())
	for _, v := range rules {
		if q.Get("rule_id") != "" && q.Get("rule_id") != v.ID {
			continue
		}
		if !includes(v.SourceTableIDs, q.Get("table_id")) || (!includes(v.Services, q.Get("service")) && len(v.Services) > 0) || q.Get("enabled") != "" && fmt.Sprint(v.Enabled) != q.Get("enabled") {
			continue
		}
		if gid := q.Get("group_id"); gid != "" {
			match := includes(v.GroupIDs, gid)
			if len(v.GroupIDs) == 0 {
				for _, t := range tables {
					if includes(v.SourceTableIDs, t.ID) && t.AlertGroupID == gid {
						match = true
					}
				}
			}
			if !match {
				continue
			}
		}
		out[v.ID] = true
	}
	return out
}
func (m *Module) listRules(w http.ResponseWriter, r *http.Request) {
	rules, e := m.rules(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	allowed := m.filteredIDs(r, rules)
	out := []Rule{}
	for _, v := range rules {
		if allowed[v.ID] {
			out = append(out, v)
		}
	}
	respond(w, out, nil)
}
func (m *Module) listTables(w http.ResponseWriter, r *http.Request) {
	tables, e := m.deps.Catalog(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	rules, e := m.rules(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	allowed := m.filteredIDs(r, rules)
	out := []any{}
	for _, t := range tables {
		all := []Rule{}
		visible := []Rule{}
		for _, v := range rules {
			if includes(v.SourceTableIDs, t.ID) {
				all = append(all, v)
				if allowed[v.ID] {
					visible = append(visible, v)
				}
			}
		}
		if t.AlertGroupID == "" && len(all) == 0 {
			continue
		}
		q := r.URL.Query()
		if q.Get("table_id") != "" && q.Get("table_id") != t.ID || q.Get("group_id") != "" && q.Get("group_id") != t.AlertGroupID && len(visible) == 0 || !includes(t.Services, q.Get("service")) {
			continue
		}
		if q.Get("enabled") != "" && len(visible) == 0 {
			continue
		}
		toCheck := all
		if len(toCheck) == 0 {
			toCheck = []Rule{{SourceTableIDs: []string{t.ID}}}
		}
		configured, routeWarnings := false, []string{}
		for _, rule := range toCheck {
			routes, warnings, routeError := m.route(r.Context(), rule)
			configured = configured || len(routes) > 0
			routeWarnings = append(routeWarnings, warnings...)
			if routeError != nil {
				routeWarnings = append(routeWarnings, routeError.Error())
			}
		}
		out = append(out, map[string]any{"table": t, "rules": visible, "configured": configured, "warning": func() string {
			if len(all) == 0 {
				if t.AlertGroupID == "" {
					return "未绑定告警组"
				}
				return "仅绑定组，暂无规则"
			}
			if len(routeWarnings) > 0 {
				return strings.Join(routeWarnings, "; ")
			}
			return ""
		}()})
	}
	respond(w, out, nil)
}
func (m *Module) preview(w http.ResponseWriter, r *http.Request) {
	var rule Rule
	if shared.Decode(r, &rule) != nil {
		shared.Error(w, 400, "invalid rule")
		return
	}
	if e := m.validateRule(r.Context(), &rule); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	v, e := m.inspect(r.Context(), rule, m.now())
	respond(w, v, e)
}
func (m *Module) listEvents(w http.ResponseWriter, r *http.Request) {
	events, e := listBodies[Event](r.Context(), m.deps.DB, "SELECT body FROM alert_events ORDER BY created_at DESC LIMIT 1000")
	if e != nil {
		respond(w, nil, e)
		return
	}
	rules, _ := m.rules(r.Context())
	allowed := m.filteredIDs(r, rules)
	out := []Event{}
	for _, v := range events {
		if r.URL.RawQuery == "" || allowed[v.RuleID] {
			out = append(out, v)
		}
	}
	respond(w, out, nil)
}
func (m *Module) listDeliveries(w http.ResponseWriter, r *http.Request) {
	rules, e := m.rules(r.Context())
	if e != nil {
		respond(w, nil, e)
		return
	}
	allowed := m.filteredIDs(r, rules)
	rows, e := m.deps.DB.QueryContext(r.Context(), "SELECT body,status FROM alert_outbox ORDER BY created_at DESC LIMIT 1000")
	if e != nil {
		respond(w, nil, e)
		return
	}
	out := []Delivery{}
	for rows.Next() {
		var raw, status string
		if e = rows.Scan(&raw, &status); e != nil {
			break
		}
		var v Delivery
		_ = json.Unmarshal([]byte(raw), &v)
		v.Status = status
		if (r.URL.Query().Get("service") != "" || r.URL.Query().Get("enabled") != "") && !allowed[v.RuleID] {
			continue
		}
		if includes(v.TableIDs, r.URL.Query().Get("table_id")) && includes(v.GroupIDs, r.URL.Query().Get("group_id")) && (r.URL.Query().Get("rule_id") == "" || v.RuleID == r.URL.Query().Get("rule_id")) && (r.URL.Query().Get("status") == "" || v.Status == r.URL.Query().Get("status")) {
			out = append(out, v)
		}
	}
	_ = rows.Close()
	respond(w, out, e)
}
func (m *Module) retryDelivery(w http.ResponseWriter, r *http.Request) {
	var raw, status string
	if m.deps.DB.QueryRowContext(r.Context(), "SELECT body,status FROM alert_outbox WHERE id=?", r.PathValue("id")).Scan(&raw, &status) != nil {
		shared.Error(w, 404, "notification not found")
		return
	}
	var d Delivery
	_ = json.Unmarshal([]byte(raw), &d)
	if status != "failed" && status != "unknown" && status != "expired" {
		shared.Error(w, 409, "only failed/unknown/expired tasks can retry")
		return
	}
	var body struct {
		Confirm bool `json:"confirm_possible_duplicate"`
	}
	_ = shared.Decode(r, &body)
	if status == "unknown" && !body.Confirm {
		shared.Error(w, 409, "重试可能重复发送，请明确确认")
		return
	}
	d.Status = "queued"
	d.Attempts = 0
	d.Error = ""
	d.NextAttempt = stamp(m.now())
	d.CreatedAt = stamp(m.now())
	respond(w, d, m.updateDelivery(r.Context(), d))
}
func (m *Module) testChannel(w http.ResponseWriter, r *http.Request) {
	var t struct {
		Recipient Recipient `json:"recipient"`
	}
	if shared.Decode(r, &t) != nil {
		shared.Error(w, 400, "invalid target")
		return
	}
	c, e := m.channel(r.Context(), r.PathValue("id"), false)
	if e != nil {
		shared.Error(w, 404, "channel not found")
		return
	}
	if e = validateRecipient(c.Type, &t.Recipient); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	now := stamp(m.now())
	event := Event{ID: id(), Kind: "test", CreatedAt: now, RuleName: "LightMoni 测试通知", Message: "这是一条由你发起的通知渠道测试。"}
	d := Delivery{ID: id(), EventID: event.ID, ChannelID: c.ID, Recipient: t.Recipient, Status: "queued", CreatedAt: now, UpdatedAt: now, NextAttempt: now, Payload: event}
	_, e = m.deps.DB.ExecContext(r.Context(), "INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, encode(d.Recipient), d.Status, d.NextAttempt, now, encode(d))
	respond(w, d, e)
}

var _ = sql.ErrNoRows
var _ = time.Second
