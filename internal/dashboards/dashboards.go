package dashboards

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lightmoni/lightmoni/internal/shared"
)

type Grid struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}
type Query struct {
	RefID   string                      `json:"refId"`
	SQL     string                      `json:"sql"`
	Params  map[string]shared.Parameter `json:"params,omitempty"`
	Enabled *bool                       `json:"enabled,omitempty"`
}
type Panel struct {
	ID      string         `json:"id"`
	Title   string         `json:"title"`
	Type    string         `json:"type"`
	Queries []Query        `json:"queries"`
	Options map[string]any `json:"options"`
	Grid    Grid           `json:"grid"`
}
type Variable struct {
	Name    string   `json:"name"`
	Label   string   `json:"label,omitempty"`
	Type    string   `json:"type"`
	Options []string `json:"options,omitempty"`
	SQL     string   `json:"sql,omitempty"`
	Multi   bool     `json:"multi,omitempty"`
	All     bool     `json:"all,omitempty"`
	Value   any      `json:"value,omitempty"`
}
type Dashboard struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Panels      []Panel      `json:"panels"`
	Variables   []Variable   `json:"variables"`
	Range       shared.Range `json:"range"`
	Refresh     int          `json:"refresh"`
	Revision    int64        `json:"revision"`
	UpdatedAt   string       `json:"updated_at"`
}
type Module struct{ deps shared.Dependencies }

var variableName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`)
var relativeTime = regexp.MustCompile(`^now(?:-[1-9][0-9]{0,6}[smhd])?$`)
var parameterReference = regexp.MustCompile(`\{([a-zA-Z][a-zA-Z0-9_]*):[^}]+\}`)

// Dependency planning ignores strings/comments; SQL execution and security stay
// with the public query engine.
func visibleSQL(text string) string {
	visible := []byte(text)
	for i := 0; i < len(text); i++ {
		if text[i] == '\'' || text[i] == '"' || text[i] == '`' {
			quote, start := text[i], i
			for i++; i < len(text); i++ {
				if text[i] == '\\' {
					i++
					continue
				}
				if text[i] == quote {
					if i+1 < len(text) && text[i+1] == quote {
						i++
						continue
					}
					break
				}
			}
			for j := start; j <= i && j < len(visible); j++ {
				visible[j] = ' '
			}
			continue
		}
		if i+1 < len(text) && text[i:i+2] == "--" {
			for ; i < len(text) && text[i] != '\n'; i++ {
				visible[i] = ' '
			}
			continue
		}
		if i+1 < len(text) && text[i:i+2] == "/*" {
			start := i
			end := strings.Index(text[i+2:], "*/")
			if end < 0 {
				i = len(text) - 1
			} else {
				i = i + end + 3
			}
			for j := start; j <= i; j++ {
				visible[j] = ' '
			}
		}
	}
	return string(visible)
}

var panelTypes = map[string]bool{"line": true, "timeseries": true, "area": true, "bar": true, "pie": true, "stat": true, "table": true, "gauge": true, "heatmap": true, "histogram": true, "timeline": true}

func New(deps shared.Dependencies) (*Module, error) {
	if deps.DB == nil {
		return nil, errors.New("dashboards: SQLite dependency required")
	}
	_, err := deps.DB.Exec(`CREATE TABLE IF NOT EXISTS dashboards(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dashboard_versions(dashboard_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,base_revision INTEGER NOT NULL,overwritten INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(dashboard_id,revision));`)
	if err != nil {
		return nil, err
	}
	return &Module{deps: deps}, nil
}
func (m *Module) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/dashboards", m.list)
	mux.HandleFunc("POST /api/v1/dashboards", m.create)
	mux.HandleFunc("GET /api/v1/dashboards/{id}", m.get)
	mux.HandleFunc("GET /api/v1/dashboards/{id}/versions", m.versions)
	mux.HandleFunc("PUT /api/v1/dashboards/{id}", m.update)
	mux.HandleFunc("DELETE /api/v1/dashboards/{id}", m.remove)
	mux.HandleFunc("POST /api/v1/dashboards/{id}/copy", m.copy)
	mux.HandleFunc("POST /api/v1/dashboards/alert-draft", m.alertDraft)
}

func (m *Module) alertDraft(w http.ResponseWriter, r *http.Request) {
	if m.deps.ReferencedTables == nil || m.deps.Catalog == nil {
		shared.Error(w, 503, "公共查询目录尚未就绪")
		return
	}
	var input struct {
		Query shared.Query `json:"query"`
		Range shared.Range `json:"range"`
	}
	if err := decode(r, &input); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	from, fromErr := time.Parse(time.RFC3339Nano, input.Range.From)
	to, toErr := time.Parse(time.RFC3339Nano, input.Range.To)
	if fromErr != nil || toErr != nil || !from.Before(to) {
		shared.Error(w, 400, "告警草稿需要有效的绝对时间范围")
		return
	}
	names, err := m.deps.ReferencedTables(r.Context(), input.Query.SQL)
	if err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	tables, err := m.deps.Catalog(r.Context())
	if err != nil {
		shared.Error(w, 503, "数据目录不可用")
		return
	}
	ids := []string{}
	for _, name := range names {
		found := false
		for _, table := range tables {
			if table.Name == name {
				ids = append(ids, table.ID)
				found = true
				break
			}
		}
		if !found {
			shared.Error(w, 400, "查询引用的表不在公开数据目录中")
			return
		}
	}
	if len(ids) == 0 {
		shared.Error(w, 400, "请选择包含监控数据表的查询")
		return
	}
	shared.JSON(w, 200, map[string]any{"sql": input.Query.SQL, "params": input.Query.Params, "range": input.Range, "source_table_ids": ids})
}
func decode(r *http.Request, v any) error {
	d := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20))
	d.UseNumber()
	if err := d.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errors.New("只允许一个 JSON 对象")
	}
	return nil
}
func normalize(d *Dashboard) error {
	d.Title = strings.TrimSpace(d.Title)
	if d.Title == "" || len([]rune(d.Title)) > 160 {
		return errors.New("大盘名称必须为 1–160 个字符")
	}
	if len(d.Description) > 8000 || len(d.Panels) > 48 || len(d.Variables) > 16 {
		return errors.New("大盘配置超出容量限制")
	}
	if d.Refresh != 0 && d.Refresh < 5 || d.Refresh > 3600 {
		return errors.New("刷新间隔须为 0 或 5–3600 秒")
	}
	if d.Range.From == "" {
		d.Range = shared.Range{From: "now-1h", To: "now"}
	}
	for _, value := range []string{d.Range.From, d.Range.To} {
		if !relativeTime.MatchString(value) {
			if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
				return errors.New("时间范围需要 ISO UTC 日期或 now-1h 等相对范围")
			}
		}
	}
	if from, err := time.Parse(time.RFC3339Nano, d.Range.From); err == nil {
		if to, err := time.Parse(time.RFC3339Nano, d.Range.To); err == nil && !from.Before(to) {
			return errors.New("开始时间必须早于结束时间")
		}
	}
	if d.Panels == nil {
		d.Panels = []Panel{}
	}
	if d.Variables == nil {
		d.Variables = []Variable{}
	}
	ids := map[string]bool{}
	for i := range d.Panels {
		p := &d.Panels[i]
		if p.ID == "" {
			p.ID = uuid.NewString()
		}
		if ids[p.ID] {
			return errors.New("面板 ID 重复")
		}
		ids[p.ID] = true
		if strings.TrimSpace(p.Title) == "" {
			p.Title = "新面板"
		}
		if !panelTypes[p.Type] {
			return fmt.Errorf("未知图表类型 %q", p.Type)
		}
		if p.Grid.W == 0 {
			p.Grid = Grid{X: (i % 2) * 6, Y: (i / 2) * 6, W: 6, H: 6}
		}
		if p.Grid.X < 0 || p.Grid.Y < 0 || p.Grid.W < 2 || p.Grid.W > 12 || p.Grid.X+p.Grid.W > 12 || p.Grid.H < 3 || p.Grid.H > 40 {
			return errors.New("面板布局范围无效")
		}
		if p.Options == nil {
			p.Options = map[string]any{}
		}
		if len(p.Queries) == 0 || len(p.Queries) > 8 {
			return errors.New("每个面板必须包含 1–8 条查询")
		}
		refs := map[string]bool{}
		for j := range p.Queries {
			q := &p.Queries[j]
			if q.RefID == "" {
				q.RefID = fmt.Sprintf("%c", 'A'+j)
			}
			if refs[q.RefID] {
				return errors.New("面板查询 refId 重复")
			}
			refs[q.RefID] = true
			if len(q.RefID) > 48 || strings.TrimSpace(q.SQL) == "" || len(q.SQL) > 100000 {
				return errors.New("查询名称或 SQL 无效")
			}
		}
	}
	names := map[string]bool{}
	for _, v := range d.Variables {
		if !variableName.MatchString(v.Name) || names[v.Name] {
			return errors.New("变量名称无效或重复")
		}
		names[v.Name] = true
		if v.Type != "custom" && v.Type != "query" && v.Type != "text" && v.Type != "constant" {
			return errors.New("未知变量类型")
		}
		if v.Type == "query" && strings.TrimSpace(v.SQL) == "" {
			return errors.New("查询变量缺少 SQL")
		}
		if len(v.SQL) > 100000 || len(v.Options) > 1000 {
			return errors.New("变量配置超出限制")
		}
	}
	active, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(name string) error {
		if visited[name] {
			return nil
		}
		if active[name] {
			return fmt.Errorf("变量依赖循环：%s", name)
		}
		active[name] = true
		for _, v := range d.Variables {
			if v.Name != name {
				continue
			}
			for _, ref := range parameterReference.FindAllStringSubmatch(visibleSQL(v.SQL), -1) {
				if names[ref[1]] {
					if err := visit(ref[1]); err != nil {
						return err
					}
				}
			}
		}
		delete(active, name)
		visited[name] = true
		return nil
	}
	for _, v := range d.Variables {
		if err := visit(v.Name); err != nil {
			return err
		}
	}
	return nil
}
func (m *Module) load(ctx context.Context, id string) (Dashboard, error) {
	var d Dashboard
	var body string
	err := m.deps.DB.QueryRowContext(ctx, `SELECT body FROM dashboards WHERE id=?`, id).Scan(&body)
	if err != nil {
		return d, err
	}
	dec := json.NewDecoder(strings.NewReader(body))
	dec.UseNumber()
	err = dec.Decode(&d)
	return d, err
}
func fail(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		shared.Error(w, 404, "大盘不存在")
	} else {
		shared.Error(w, 500, "大盘存储操作失败")
	}
}
func (m *Module) list(w http.ResponseWriter, r *http.Request) {
	rows, err := m.deps.DB.QueryContext(r.Context(), `SELECT body FROM dashboards ORDER BY updated_at DESC,id`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	out := []Dashboard{}
	for rows.Next() {
		var body string
		var d Dashboard
		if err = rows.Scan(&body); err != nil {
			fail(w, err)
			return
		}
		decoder := json.NewDecoder(strings.NewReader(body))
		decoder.UseNumber()
		if err = decoder.Decode(&d); err != nil {
			fail(w, err)
			return
		}
		out = append(out, d)
	}
	if rows.Err() != nil {
		fail(w, rows.Err())
		return
	}
	shared.JSON(w, 200, out)
}
func (m *Module) insert(ctx context.Context, d *Dashboard) error {
	d.ID = uuid.NewString()
	d.Revision = 1
	d.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if err := normalize(d); err != nil {
		return err
	}
	body, err := json.Marshal(d)
	if err != nil {
		return err
	}
	tx, err := m.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO dashboards(id,title,body,revision,updated_at) VALUES(?,?,?,?,?)`, d.ID, d.Title, string(body), d.Revision, d.UpdatedAt); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision) VALUES(?,?,?,?,0)`, d.ID, d.Revision, string(body), d.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit()
}
func (m *Module) create(w http.ResponseWriter, r *http.Request) {
	var d Dashboard
	if err := decode(r, &d); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	if err := normalize(&d); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	if err := m.insert(r.Context(), &d); err != nil {
		fail(w, err)
		return
	}
	shared.JSON(w, 201, d)
}
func (m *Module) get(w http.ResponseWriter, r *http.Request) {
	d, err := m.load(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	shared.JSON(w, 200, d)
}
func (m *Module) update(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Dashboard
		OverwriteRevision int64 `json:"overwrite_revision"`
	}
	if err := decode(r, &input); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	d := input.Dashboard
	d.ID = r.PathValue("id")
	if d.Revision < 1 {
		shared.Error(w, 400, "更新需要 revision")
		return
	}
	if err := normalize(&d); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	expected := d.Revision
	if input.OverwriteRevision < 0 {
		shared.Error(w, 400, "覆盖版本无效")
		return
	}
	if input.OverwriteRevision > 0 {
		expected = input.OverwriteRevision
	}
	d.Revision = expected + 1
	d.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	body, err := json.Marshal(d)
	if err != nil {
		shared.Error(w, 400, "配置无法编码")
		return
	}
	tx, err := m.deps.DB.BeginTx(r.Context(), nil)
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(r.Context(), `UPDATE dashboards SET title=?,body=?,revision=?,updated_at=? WHERE id=? AND revision=?`, d.Title, string(body), d.Revision, d.UpdatedAt, d.ID, expected)
	if err != nil {
		fail(w, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		_ = tx.Rollback()
		current, loadErr := m.load(r.Context(), d.ID)
		if loadErr != nil {
			fail(w, loadErr)
			return
		}
		shared.JSON(w, 409, map[string]any{"error": "大盘已被其他成员更新，请选择保留草稿、另存副本或覆盖已显示的版本", "code": "revision_conflict", "current": current})
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision,overwritten) VALUES(?,?,?,?,?,?)`, d.ID, d.Revision, string(body), d.UpdatedAt, expected, input.OverwriteRevision > 0); err != nil {
		fail(w, err)
		return
	}
	if err = tx.Commit(); err != nil {
		fail(w, err)
		return
	}
	shared.JSON(w, 200, d)
}

func (m *Module) versions(w http.ResponseWriter, r *http.Request) {
	if _, err := m.load(r.Context(), r.PathValue("id")); err != nil {
		fail(w, err)
		return
	}
	rows, err := m.deps.DB.QueryContext(r.Context(), `SELECT revision,updated_at,base_revision,overwritten FROM dashboard_versions WHERE dashboard_id=? ORDER BY revision DESC LIMIT 100`, r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var revision, base int64
		var updated string
		var overwritten bool
		if err = rows.Scan(&revision, &updated, &base, &overwritten); err != nil {
			fail(w, err)
			return
		}
		out = append(out, map[string]any{"revision": revision, "updated_at": updated, "base_revision": base, "overwritten": overwritten})
	}
	if err = rows.Err(); err != nil {
		fail(w, err)
		return
	}
	shared.JSON(w, 200, out)
}
func (m *Module) remove(w http.ResponseWriter, r *http.Request) {
	result, err := m.deps.DB.ExecContext(r.Context(), `DELETE FROM dashboards WHERE id=? AND revision=?`, r.PathValue("id"), r.URL.Query().Get("revision"))
	if err != nil {
		fail(w, err)
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		if _, err = m.load(r.Context(), r.PathValue("id")); err != nil {
			fail(w, err)
			return
		}
		shared.Error(w, 409, "大盘已更新，请重新加载后删除")
		return
	}
	shared.JSON(w, 200, map[string]bool{"deleted": true})
}
func (m *Module) copy(w http.ResponseWriter, r *http.Request) {
	d, err := m.load(r.Context(), r.PathValue("id"))
	if err != nil {
		fail(w, err)
		return
	}
	input := struct {
		Title string `json:"title"`
	}{}
	if err = decode(r, &input); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	if input.Title != "" {
		d.Title = input.Title
	} else {
		d.Title += " · 副本"
	}
	for i := range d.Panels {
		d.Panels[i].ID = uuid.NewString()
	}
	if err = normalize(&d); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	if err = m.insert(r.Context(), &d); err != nil {
		fail(w, err)
		return
	}
	shared.JSON(w, 201, d)
}
