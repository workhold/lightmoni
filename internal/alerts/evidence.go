package alerts

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func identifier(v string) string { return "`" + strings.ReplaceAll(v, "`", "``") + "`" }
func (m *Module) table(ctx context.Context, id string) (shared.Table, error) {
	ts, e := m.deps.Catalog(ctx)
	if e != nil {
		return shared.Table{}, e
	}
	for _, t := range ts {
		if t.ID == id {
			return t, nil
		}
	}
	return shared.Table{}, fmt.Errorf("数据表不存在")
}

// Infer a source only when the catalog makes the service association unambiguous.
// An explicit empty profile disables this inference.
func (m *Module) autoEvidenceProfile(ctx context.Context, r *Rule) {
	tables, e := m.deps.Catalog(ctx)
	if e != nil {
		return
	}
	logs := []shared.Table{}
	traces := []string{}
	for _, t := range tables {
		if t.Kind == "log" {
			if r.Kind == "log" && includes(r.SourceTableIDs, t.ID) {
				logs = append(logs, t)
			} else if r.Kind != "log" && len(r.Services) > 0 {
				covered := true
				for _, svc := range r.Services {
					covered = covered && includes(t.Services, svc)
				}
				if covered {
					logs = append(logs, t)
				}
			}
		}
		if t.Kind == "trace" {
			for _, svc := range r.Services {
				if includes(t.Services, svc) {
					traces = append(traces, t.ID)
					break
				}
			}
		}
	}
	if len(logs) != 1 {
		return
	}
	if len(r.Services) == 0 {
		all := []string{}
		for _, t := range tables {
			if t.Kind == "trace" {
				all = append(all, t.ID)
			}
		}
		if len(all) == 1 {
			traces = all
		}
	}
	if len(traces) > 8 {
		traces = nil
	}
	r.EvidenceProfile = &EvidenceProfile{LogTableID: logs[0].ID, TraceTableIDs: traces, LookbackSeconds: 120}
}
func hasColumn(t shared.Table, name string) bool {
	for _, c := range t.Columns {
		if c.Name == name {
			return true
		}
	}
	return false
}
func frameMaps(response shared.QueryResponse) ([]map[string]any, bool, error) {
	out := []map[string]any{}
	truncated := false
	for _, result := range response.Results {
		if result.Status == "error" || result.Status == "cancelled" {
			return nil, false, fmt.Errorf("现场查询失败")
		}
		truncated = truncated || result.Truncated
		for _, f := range result.Frames {
			for _, row := range f.Rows {
				v := map[string]any{}
				for i, c := range f.Columns {
					if i < len(row) {
						v[c.Name] = row[i]
					}
				}
				out = append(out, v)
			}
		}
	}
	return out, truncated, nil
}
func (m *Module) collectEvidence(ctx context.Context, r IncidentResponse, p EvidenceProfile) Evidence {
	e := Evidence{Status: "ready", CapturedAt: stamp(m.now()), RangeFrom: r.Event.Range.From, RangeTo: r.Event.Range.To, LogTableID: p.LogTableID, TraceTableIDs: p.TraceTableIDs, Logs: []map[string]any{}, TraceIDs: []string{}}
	if seconds := p.LookbackSeconds; seconds > 0 {
		e.RangeFrom = stamp(parse(e.RangeFrom).Add(-time.Duration(seconds) * time.Second))
	}
	table, err := m.table(ctx, p.LogTableID)
	if err != nil {
		e.Status = "failed"
		e.Error = err.Error()
		return e
	}
	columns := []string{}
	for _, c := range []string{"event_id", "event_time", "service", "severity", "body", "trace_id", "span_id", "source_id"} {
		if hasColumn(table, c) {
			columns = append(columns, identifier(c))
		}
	}
	if len(columns) == 0 {
		e.Status = "failed"
		e.Error = "日志表缺少现场字段"
		return e
	}
	where := []string{"$__timeFilter(event_time)"}
	params := map[string]shared.Parameter{}
	var rule Rule
	var raw string
	if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", r.RuleID).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &rule)
	}
	labels := map[string]string{}
	for k, v := range r.Event.State.Labels {
		labels[k] = v
	}
	if len(rule.Services) == 1 {
		labels["service"] = rule.Services[0]
	}
	if len(rule.Services) > 1 && hasColumn(table, "service") {
		params["services"] = shared.Parameter{Type: "Array(String)", Value: rule.Services}
		where = append(where, "service IN {services:Array(String)}")
	}
	if rule.Kind == "log" && includes(rule.SourceTableIDs, p.LogTableID) {
		if v, ok := rule.Params["alert_levels"]; ok && v.Type == "Array(String)" {
			params["evidence_levels"] = v
			where = append(where, "severity IN {evidence_levels:Array(String)}")
		}
		if v, ok := rule.Params["alert_keyword"]; ok && v.Type == "String" && valueString(v.Value) != "" {
			params["evidence_keyword"] = v
			where = append(where, "positionCaseInsensitiveUTF8(body,{evidence_keyword:String})>0")
		}
	}
	for k, v := range labels {
		field := k
		if mapped := p.LabelMappings[k]; mapped != "" {
			field = mapped
		}
		if !hasColumn(table, field) && !strings.HasPrefix(field, "attributes.") {
			continue
		}
		name := fmt.Sprintf("label_%d", len(params))
		params[name] = shared.Parameter{Type: "String", Value: v}
		if strings.HasPrefix(field, "attributes.") && hasColumn(table, "attributes_json") {
			keyName := name + "_key"
			params[keyName] = shared.Parameter{Type: "String", Value: strings.TrimPrefix(field, "attributes.")}
			where = append(where, "JSONExtractString(attributes_json,{"+keyName+":String})={"+name+":String}")
		} else {
			where = append(where, "toString("+identifier(field)+")={"+name+":String}")
		}
	}
	if len(where) == 1 && !(rule.Kind == "log" && includes(rule.SourceTableIDs, p.LogTableID)) {
		e.Status = "unconfigured"
		e.Error = "需要配置service或实例标签关联，避免返回无关日志"
		return e
	}
	order := "event_time DESC"
	if hasColumn(table, "severity_number") {
		order = "severity_number DESC,event_time DESC"
	}
	query := shared.QueryRequest{RequestID: id(), Source: "alert", Range: shared.Range{From: e.RangeFrom, To: e.RangeTo}, Queries: []shared.Query{{RefID: "evidence", SQL: "SELECT " + strings.Join(columns, ",") + " FROM " + identifier(table.Name) + " WHERE " + strings.Join(where, " AND ") + " ORDER BY " + order + " LIMIT 11", Params: params}}}
	response, err := m.deps.Query(ctx, query)
	if err != nil {
		e.Status = "failed"
		e.Error = "现场日志查询超时或失败"
		return e
	}
	logs, truncated, err := frameMaps(response)
	if err != nil {
		e.Status = "failed"
		e.Error = err.Error()
		return e
	}
	e.Truncated = truncated || len(logs) > 10
	if len(logs) > 10 {
		logs = logs[:10]
	}
	bytes := 0
	seen := map[string]bool{}
	for _, log := range logs {
		if body, ok := log["body"].(string); ok {
			log["body"] = redactSnippet(body)
		}
		b, _ := json.Marshal(log)
		if bytes+len(b) > 32768 {
			e.Truncated = true
			break
		}
		bytes += len(b)
		e.Logs = append(e.Logs, log)
		if trace, ok := log["trace_id"].(string); ok && trace != "" && !seen[trace] && len(e.TraceIDs) < 3 {
			seen[trace] = true
			e.TraceIDs = append(e.TraceIDs, trace)
		}
	}
	if len(e.Logs) == 0 {
		e.Status = "empty"
	}
	return e
}

var sensitiveSnippet = regexp.MustCompile(`(?i)(authorization|password|access[_-]?token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+`)

func redactSnippet(v string) string {
	v = sensitiveSnippet.ReplaceAllString(v, "$1=[redacted]")
	if utf8.RuneCountInString(v) > 500 {
		v = string([]rune(v)[:500]) + "…"
	}
	return v
}
func (m *Module) CollectPendingEvidence(ctx context.Context) error {
	rs, e := listBodies[IncidentResponse](ctx, m.deps.DB, "SELECT body FROM alert_responses WHERE json_extract(body,'$.evidence.status')='pending' ORDER BY created_at LIMIT 1")
	if e != nil || len(rs) == 0 {
		return e
	}
	r := rs[0]
	var raw string
	var rule Rule
	if m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_rules WHERE id=?", r.RuleID).Scan(&raw) != nil {
		return nil
	}
	if e = json.Unmarshal([]byte(raw), &rule); e != nil {
		return e
	}
	evidence := Evidence{Status: "unconfigured"}
	if rule.EvidenceProfile != nil {
		limited, cancel := context.WithTimeout(ctx, 2*time.Second)
		evidence = m.collectEvidence(limited, r, *rule.EvidenceProfile)
		cancel()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, e = m.deps.DB.ExecContext(ctx, "UPDATE alert_responses SET body=json_set(body,'$.evidence',json(?)) WHERE id=? AND json_extract(body,'$.evidence.status')='pending'", encode(evidence), r.ID)
	return e
}
func (m *Module) evidenceText(ctx context.Context, d Delivery) string {
	if d.ResponseID == "" {
		return ""
	}
	r, e := m.response(ctx, d.ResponseID)
	if e != nil || len(r.Evidence.Logs) == 0 {
		return ""
	}
	text := "\n现场日志："
	for i, v := range r.Evidence.Logs {
		if i == 3 {
			break
		}
		text += "\n" + fmt.Sprint(v["event_time"]) + " " + fmt.Sprint(v["severity"]) + " " + fmt.Sprint(v["body"])
	}
	return text
}
func (m *Module) traceDetail(w http.ResponseWriter, r *http.Request) {
	trace := r.PathValue("trace_id")
	if len(trace) < 1 || len(trace) > 256 {
		shared.Error(w, 400, "无效的Trace ID")
		return
	}
	from, to := parse(r.URL.Query().Get("from")), parse(r.URL.Query().Get("to"))
	if from.IsZero() || !to.After(from) || to.Sub(from) > 24*time.Hour {
		shared.Error(w, 400, "Trace查询需要不超过24小时的固定时间范围")
		return
	}
	ids := strings.Split(r.URL.Query().Get("tables"), ",")
	if len(ids) > 8 || len(ids) == 0 {
		shared.Error(w, 400, "Trace数据表超限")
		return
	}
	spans := []map[string]any{}
	truncated := false
	for _, tid := range ids {
		t, e := m.table(r.Context(), tid)
		if e != nil || t.Kind != "trace" {
			shared.Error(w, 400, "需要指定有效的Trace表")
			return
		}
		columns := []string{}
		for _, c := range []string{"event_id", "service", "trace_id", "span_id", "parent_span_id", "name", "kind", "start_time", "end_time", "duration_ns", "status", "attributes_json", "events_json"} {
			if hasColumn(t, c) {
				columns = append(columns, identifier(c))
			}
		}
		if len(columns) == 0 {
			continue
		}
		response, e := m.deps.Query(r.Context(), shared.QueryRequest{RequestID: id(), Source: "interactive", Range: shared.Range{From: stamp(from), To: stamp(to)}, Queries: []shared.Query{{RefID: "trace", SQL: "SELECT " + strings.Join(columns, ",") + " FROM " + identifier(t.Name) + " WHERE trace_id={trace_id:String} AND $__timeFilter(event_time) ORDER BY start_time,span_id LIMIT 2001", Params: map[string]shared.Parameter{"trace_id": {Type: "String", Value: trace}}}}})
		if e != nil {
			shared.Error(w, 502, "Trace查询失败")
			return
		}
		values, cut, e := frameMaps(response)
		if e != nil {
			shared.Error(w, 502, e.Error())
			return
		}
		if len(values) > 2000 {
			values = values[:2000]
			cut = true
		}
		truncated = truncated || cut
		for _, v := range values {
			v["table_id"] = tid
			spans = append(spans, v)
		}
	}
	known := map[string]bool{}
	for _, v := range spans {
		known[fmt.Sprint(v["span_id"])] = true
	}
	missing := 0
	for _, v := range spans {
		p := fmt.Sprint(v["parent_span_id"])
		if p != "" && p != "0000000000000000" && !known[p] {
			missing++
		}
	}
	shared.JSON(w, 200, map[string]any{"trace_id": trace, "spans": spans, "truncated": truncated, "incomplete": missing > 0 || truncated || len(spans) == 0, "missing_parents": missing, "from": stamp(from), "to": stamp(to)})
}
