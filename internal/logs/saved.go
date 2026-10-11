package logs

import (
	"database/sql"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/shared"
	"net/http"
	"strings"
	"time"
)

type Saved struct {
	ID        string         `json:"id"`
	Title     string         `json:"title"`
	Spec      Spec           `json:"spec"`
	View      map[string]any `json:"view"`
	Revision  int64          `json:"revision"`
	UpdatedAt string         `json:"updated_at"`
}

func scanSaved(row interface{ Scan(...any) error }) (Saved, error) {
	var s Saved
	var spec, view string
	e := row.Scan(&s.ID, &s.Title, &spec, &view, &s.Revision, &s.UpdatedAt)
	if e == nil {
		e = json.Unmarshal([]byte(spec), &s.Spec)
	}
	if e == nil {
		e = json.Unmarshal([]byte(view), &s.View)
	}
	return s, e
}
func (m *Module) listSaved(w http.ResponseWriter, r *http.Request) {
	rows, e := m.deps.DB.QueryContext(r.Context(), "SELECT id,title,spec,view,revision,updated_at FROM log_saved_searches ORDER BY updated_at DESC")
	if e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	defer rows.Close()
	items := []Saved{}
	for rows.Next() {
		s, e := scanSaved(rows)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		items = append(items, s)
	}
	if e = rows.Err(); e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	shared.JSON(w, 200, items)
}
func (m *Module) getSaved(w http.ResponseWriter, r *http.Request) {
	s, e := scanSaved(m.deps.DB.QueryRowContext(r.Context(), "SELECT id,title,spec,view,revision,updated_at FROM log_saved_searches WHERE id=?", r.PathValue("id")))
	if e == sql.ErrNoRows {
		shared.Error(w, 404, "保存检索不存在")
		return
	}
	if e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	shared.JSON(w, 200, s)
}
func (m *Module) writeSaved(w http.ResponseWriter, r *http.Request, update bool) {
	var s Saved
	if shared.Decode(r, &s) != nil {
		shared.Error(w, 400, "无效保存检索")
		return
	}
	s.Title = strings.TrimSpace(s.Title)
	if s.Title == "" || len(s.Title) > 240 {
		shared.Error(w, 400, "名称需要 1–240 字节")
		return
	}
	if _, _, _, e := m.compile(r.Context(), s.Spec); e != nil {
		shared.Error(w, 400, e.Error())
		return
	}
	spec, _ := json.Marshal(s.Spec)
	view, e := json.Marshal(s.View)
	if e != nil || len(view) > 65536 {
		shared.Error(w, 400, "显示配置超过限制")
		return
	}
	s.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if update {
		if s.Revision < 1 {
			shared.Error(w, 400, "修改需要 revision")
			return
		}
		s.ID = r.PathValue("id")
		result, e := m.deps.DB.ExecContext(r.Context(), "UPDATE log_saved_searches SET title=?,spec=?,view=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?", s.Title, string(spec), string(view), s.UpdatedAt, s.ID, s.Revision)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			var count int
			_ = m.deps.DB.QueryRowContext(r.Context(), "SELECT count(*) FROM log_saved_searches WHERE id=?", s.ID).Scan(&count)
			if count == 0 {
				shared.Error(w, 404, "保存检索不存在")
			} else {
				shared.Error(w, 409, "检索已被其他成员修改，请重新打开后保存")
			}
			return
		}
		s.Revision++
	} else {
		s.ID = newID()
		s.Revision = 1
		_, e := m.deps.DB.ExecContext(r.Context(), "INSERT INTO log_saved_searches(id,title,spec,view,revision,updated_at) VALUES(?,?,?,?,1,?)", s.ID, s.Title, string(spec), string(view), s.UpdatedAt)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
	}
	shared.JSON(w, 200, s)
}
func (m *Module) createSaved(w http.ResponseWriter, r *http.Request) { m.writeSaved(w, r, false) }
func (m *Module) updateSaved(w http.ResponseWriter, r *http.Request) { m.writeSaved(w, r, true) }
func (m *Module) deleteSaved(w http.ResponseWriter, r *http.Request) {
	result, e := m.deps.DB.ExecContext(r.Context(), "DELETE FROM log_saved_searches WHERE id=?", r.PathValue("id"))
	if e != nil {
		shared.Error(w, 500, e.Error())
		return
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		shared.Error(w, 404, "保存检索不存在")
		return
	}
	shared.JSON(w, 200, map[string]bool{"ok": true})
}
