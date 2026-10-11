package logs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

const maxRows = 2000
const maxBytes = 8 << 20
const maxCacheBytes = 32 << 20
const sessionTTL = 2 * time.Minute

type session struct {
	ID, Owner, Spec, SQL, BaseSQL, HistogramSQL string
	Params                                      map[string]shared.Parameter
	Frame, Histogram                            shared.Frame
	Truncated                                   bool
	HistogramTruncated                          bool
	IntervalMS                                  int64
	Bytes                                       int
	Created, Expires                            time.Time
	Range                                       shared.Range
}
type Module struct {
	deps     shared.Dependencies
	mu       sync.Mutex
	sessions map[string]*session
	now      func() time.Time
}

func newID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func New(deps shared.Dependencies) (*Module, error) {
	if deps.DB == nil || deps.Query == nil || deps.Catalog == nil {
		return nil, errors.New("logs: SQLite, Query and Catalog dependencies required")
	}
	_, e := deps.DB.Exec(`CREATE TABLE IF NOT EXISTS log_saved_searches(id TEXT PRIMARY KEY,title TEXT NOT NULL,spec TEXT NOT NULL,view TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL)`)
	if e != nil {
		return nil, e
	}
	return &Module{deps: deps, sessions: map[string]*session{}, now: time.Now}, nil
}
func (m *Module) Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v1/logs/search", m.search)
	mux.HandleFunc("POST /api/v1/logs/aggregate", m.aggregate)
	mux.HandleFunc("POST /api/v1/logs/tail", m.tail)
	mux.HandleFunc("POST /api/v1/logs/context", m.context)
	mux.HandleFunc("GET /api/v1/logs/{table}/events/{event}", m.detail)
	mux.HandleFunc("GET /api/v1/logs/saved-searches", m.listSaved)
	mux.HandleFunc("POST /api/v1/logs/saved-searches", m.createSaved)
	mux.HandleFunc("GET /api/v1/logs/saved-searches/{id}", m.getSaved)
	mux.HandleFunc("PUT /api/v1/logs/saved-searches/{id}", m.updateSaved)
	mux.HandleFunc("DELETE /api/v1/logs/saved-searches/{id}", m.deleteSaved)
}
func (m *Module) keep(s *session) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	size := s.Bytes
	for id, v := range m.sessions {
		if !v.Expires.After(now) {
			delete(m.sessions, id)
		} else {
			size += v.Bytes
		}
	}
	for len(m.sessions) >= 32 || size > maxCacheBytes {
		var oldest *session
		for _, v := range m.sessions {
			if oldest == nil || v.Created.Before(oldest.Created) {
				oldest = v
			}
		}
		if oldest == nil {
			break
		}
		size -= oldest.Bytes
		delete(m.sessions, oldest.ID)
	}
	m.sessions[s.ID] = s
}
func (m *Module) get(id, owner string) (*session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[id]
	if s == nil || s.Owner != owner {
		return nil, false
	}
	if !s.Expires.After(m.now()) {
		delete(m.sessions, id)
		return nil, false
	}
	return s, true
}
func freeze(frame shared.Frame) (shared.Frame, bool, int, error) {
	return freezeBudget(frame, maxBytes, maxRows)
}
func freezeBudget(frame shared.Frame, budget, rowLimit int) (shared.Frame, bool, int, error) {
	out := shared.Frame{Columns: append([]shared.Column(nil), frame.Columns...), Rows: [][]any{}}
	used := 0
	truncated := len(frame.Rows) > rowLimit
	for _, row := range frame.Rows {
		if len(out.Rows) >= rowLimit {
			break
		}
		raw, e := json.Marshal(row)
		if e != nil {
			return out, false, used, e
		}
		if used+len(raw) > budget {
			truncated = true
			break
		}
		var clone []any
		d := json.Unmarshal(raw, &clone)
		if d != nil {
			return out, false, used, d
		}
		out.Rows = append(out.Rows, clone)
		used += len(raw)
	}
	return out, truncated, used, nil
}

type searchRequest struct {
	Spec      Spec   `json:"spec"`
	SessionID string `json:"session_id,omitempty"`
	Cursor    string `json:"cursor,omitempty"`
	Limit     int    `json:"limit,omitempty"`
	AnchorID  string `json:"anchor_id,omitempty"`
}

func (m *Module) search(w http.ResponseWriter, r *http.Request) {
	var req searchRequest
	if shared.Decode(r, &req) != nil {
		shared.Error(w, 400, "无效查询请求")
		return
	}
	limit := req.Limit
	if limit == 0 {
		limit = 200
	}
	if limit < 1 || limit > 1000 {
		shared.Error(w, 400, "每页需要 1–1000 条")
		return
	}
	var s *session
	offset := 0
	if req.SessionID != "" {
		var ok bool
		s, ok = m.get(req.SessionID, shared.CurrentUser(r).ID)
		if !ok {
			shared.Error(w, 410, "查询会话已过期，请保留条件重新查询")
			return
		}
		n, e := strconv.Atoi(req.Cursor)
		if e != nil || n < 0 || n > len(s.Frame.Rows) {
			shared.Error(w, 400, "无效页游标")
			return
		}
		offset = n
	} else {
		base, params, _, e := m.compile(r.Context(), req.Spec)
		if e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		direction := "DESC"
		if req.Spec.Sort == "asc" {
			direction = "ASC"
		}
		sql := base + " ORDER BY event_time " + direction + ",event_id " + direction + fmt.Sprintf(" LIMIT %d", maxRows+1)
		hist := "SELECT $__timeInterval(event_time) AS time,severity,count() AS count FROM (" + base + ") GROUP BY time,severity ORDER BY time,severity"
		results, e := m.execute(r.Context(), req.Spec, []shared.Query{{RefID: "rows", SQL: sql, Params: params}, {RefID: "histogram", SQL: hist, Params: params}})
		if e != nil {
			shared.Error(w, 422, e.Error())
			return
		}
		if len(results[0].Frames) != 1 || len(results[1].Frames) != 1 {
			shared.Error(w, 502, "查询没有返回标准数据框架")
			return
		}
		histFrame, histTruncated, histBytes, e := freezeBudget(results[1].Frames[0], maxBytes, maxRows)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		frame, truncated, used, e := freezeBudget(results[0].Frames[0], maxBytes-histBytes, maxRows)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		columns := map[string]bool{}
		for _, c := range frame.Columns {
			columns[c.Name] = true
		}
		for _, name := range []string{"event_id", "event_time", "service", "body"} {
			if !columns[name] {
				shared.Error(w, 400, "日志 SQL 必须保留 event_id,event_time,service,body 等原始日志字段；聚合查询请使用 SQL 工作台")
				return
			}
		}
		bucket, _ := selectedInterval(req.Spec)
		now := m.now()
		s = &session{ID: newID(), Owner: shared.CurrentUser(r).ID, Spec: rawSpec(req.Spec), SQL: sql, BaseSQL: base, HistogramSQL: hist, Params: params, Range: req.Spec.Range, Frame: frame, Histogram: histFrame, IntervalMS: bucket, Truncated: truncated || results[0].Truncated, HistogramTruncated: histTruncated || results[1].Truncated, Bytes: used + histBytes, Created: now, Expires: now.Add(sessionTTL)}
		m.keep(s)
	}
	anchorFound := req.AnchorID == ""
	if req.AnchorID != "" && req.SessionID == "" {
		for i, row := range s.Frame.Rows {
			if rowObject(s.Frame, row)["event_id"] == req.AnchorID {
				offset = (i / limit) * limit
				anchorFound = true
				break
			}
		}
	}
	end := min(len(s.Frame.Rows), offset+limit)
	next := ""
	if end < len(s.Frame.Rows) {
		next = strconv.Itoa(end)
	}
	shared.JSON(w, 200, map[string]any{"frame": shared.Frame{Columns: s.Frame.Columns, Rows: s.Frame.Rows[offset:end]}, "histogram": s.Histogram, "histogram_truncated": s.HistogramTruncated, "session_id": s.ID, "next_cursor": next, "total_loaded": len(s.Frame.Rows), "truncated": s.Truncated, "expires_at": s.Expires.UTC().Format(time.RFC3339Nano), "generated_at": s.Created.UTC().Format(time.RFC3339Nano), "range": s.Range, "sql": s.SQL, "count_sql": "SELECT count() AS value FROM (" + s.BaseSQL + ")", "histogram_sql": s.HistogramSQL, "params": s.Params, "interval_ms": s.IntervalMS, "scope": "bounded_session; histogram_independent_range_aggregation", "anchor_found": anchorFound})
}
func (m *Module) detail(w http.ResponseWriter, r *http.Request) {
	spec := Spec{TableID: r.PathValue("table"), Range: shared.Range{From: r.URL.Query().Get("from"), To: r.URL.Query().Get("to")}}
	base, p, _, e := m.compile(r.Context(), spec)
	if e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	p["lm_log_event"] = shared.Parameter{Type: "String", Value: r.PathValue("event")}
	results, e := m.execute(r.Context(), spec, []shared.Query{{RefID: "event", SQL: base + " AND event_id={lm_log_event:String} LIMIT 1", Params: p}})
	if e != nil {
		shared.Error(w, 422, e.Error())
		return
	}
	if len(results[0].Frames) == 0 || len(results[0].Frames[0].Rows) == 0 {
		shared.Error(w, 404, "日志未保留或不在当前时间范围内")
		return
	}
	shared.JSON(w, 200, map[string]any{"frame": results[0].Frames[0]})
}
func (m *Module) context(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Spec    Spec   `json:"spec"`
		EventID string `json:"event_id"`
		Limit   int    `json:"limit"`
	}
	if shared.Decode(r, &req) != nil || req.EventID == "" {
		shared.Error(w, 400, "缺少上下文锚点")
		return
	}
	req.Spec.Mode = "filters"
	req.Spec.Filters = nil
	req.Spec.Services = nil
	req.Spec.Keyword = ""
	base, p, _, e := m.compile(r.Context(), req.Spec)
	if e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	p["lm_log_event"] = shared.Parameter{Type: "String", Value: req.EventID}
	result, e := m.execute(r.Context(), req.Spec, []shared.Query{{RefID: "anchor", SQL: base + " AND event_id={lm_log_event:String} LIMIT 1", Params: p}})
	if e != nil {
		shared.Error(w, 422, e.Error())
		return
	}
	if len(result[0].Frames) == 0 || len(result[0].Frames[0].Rows) == 0 {
		shared.Error(w, 404, "上下文锚点未保留")
		return
	}
	f := result[0].Frames[0]
	anchor := rowObject(f, f.Rows[0])
	source, ok := anchor["source_id"].(string)
	if !ok || source == "" {
		shared.Error(w, 400, "该日志没有可靠来源标识")
		return
	}
	p["lm_log_source"] = shared.Parameter{Type: "String", Value: source}
	p["lm_log_service"] = shared.Parameter{Type: "String", Value: fmt.Sprint(anchor["service"])}
	p["lm_log_time"] = shared.Parameter{Type: "String", Value: fmt.Sprint(anchor["event_time"])}
	field := "event_time"
	value := "parseDateTime64BestEffort({lm_log_time:String},9)"
	order := "event_time"
	mode := "event_time"
	if anchor["source_seq"] != nil {
		field = "source_seq"
		value = "{lm_log_seq:UInt64}"
		order = "source_seq"
		mode = "source_seq"
		p["lm_log_seq"] = shared.Parameter{Type: "UInt64", Value: fmt.Sprint(anchor["source_seq"])}
	}
	limit := req.Limit
	if limit < 1 {
		limit = 25
	}
	if limit > 100 {
		shared.Error(w, 400, "每侧上下文最多 100 条")
		return
	}
	scope := base + " AND source_id={lm_log_source:String} AND service={lm_log_service:String}"
	prev := scope + " AND (" + field + ",event_id)<(" + value + ",{lm_log_event:String}) ORDER BY " + order + " DESC,event_id DESC LIMIT " + strconv.Itoa(limit)
	next := scope + " AND (" + field + ",event_id)>(" + value + ",{lm_log_event:String}) ORDER BY " + order + " ASC,event_id ASC LIMIT " + strconv.Itoa(limit)
	rr, e := m.execute(r.Context(), req.Spec, []shared.Query{{RefID: "before", SQL: prev, Params: p}, {RefID: "after", SQL: next, Params: p}})
	if e != nil {
		shared.Error(w, 422, e.Error())
		return
	}
	rows := [][]any{}
	if len(rr[0].Frames) > 0 {
		before := rr[0].Frames[0].Rows
		for i := len(before) - 1; i >= 0; i-- {
			rows = append(rows, before[i])
		}
	}
	rows = append(rows, f.Rows[0])
	if len(rr[1].Frames) > 0 {
		rows = append(rows, rr[1].Frames[0].Rows...)
	}
	shared.JSON(w, 200, map[string]any{"frame": shared.Frame{Columns: f.Columns, Rows: rows}, "source_id": source, "order": mode, "anchor_id": req.EventID, "limit_per_side": limit, "scope": "同表同来源；关键词、级别与属性过滤已移除；保留当前时间范围"})
}
func (m *Module) tail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Spec  Spec   `json:"spec"`
		Since string `json:"since"`
	}
	if shared.Decode(r, &req) != nil {
		shared.Error(w, 400, "无效实时请求")
		return
	}
	if req.Spec.Mode == "sql" {
		shared.Error(w, 400, "SQL 模式使用手动刷新；实时支持结构化检索")
		return
	}
	now := m.now().UTC()
	since, e := time.Parse(time.RFC3339Nano, req.Since)
	if e != nil || since.After(now) {
		shared.Error(w, 400, "无效实时时间游标")
		return
	}
	if now.Sub(since) > 2*time.Minute {
		shared.Error(w, 409, "实时连接间隔超过 2 分钟，请完整重新查询")
		return
	}
	base, p, _, e := m.compile(r.Context(), req.Spec)
	if e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	p["lm_log_since"] = shared.Parameter{Type: "String", Value: since.Add(-15 * time.Second).Format(time.RFC3339Nano)}
	p["lm_log_until"] = shared.Parameter{Type: "String", Value: now.Format(time.RFC3339Nano)}
	sql := base + " AND ingested_at>=parseDateTime64BestEffort({lm_log_since:String},9) AND ingested_at<parseDateTime64BestEffort({lm_log_until:String},9) ORDER BY ingested_at ASC,event_id ASC LIMIT " + strconv.Itoa(maxRows+1)
	rr, e := m.execute(r.Context(), req.Spec, []shared.Query{{RefID: "tail", SQL: sql, Params: p}})
	if e != nil {
		shared.Error(w, 422, e.Error())
		return
	}
	if len(rr[0].Frames) != 1 {
		shared.Error(w, 502, "实时查询没有返回 frame")
		return
	}
	frame, truncated, _, e := freeze(rr[0].Frames[0])
	if e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	truncated = truncated || rr[0].Truncated
	shared.JSON(w, 200, map[string]any{"frame": frame, "next_since": now.Format(time.RFC3339Nano), "truncated": truncated, "overlap_seconds": 15, "scope": "接收时间重叠 15 秒；查询可见延迟超过窗口时需要历史重查"})
}
