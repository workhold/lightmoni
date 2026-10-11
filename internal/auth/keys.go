package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

var ErrTableNotAllowed = errors.New("key cannot write to this table")

// Existing keys start with no table grants. Administrators must explicitly
// configure them before ingestion resumes; absence never means global access.
func migrateKeyTables(db *sql.DB) error {
	rows, err := db.Query("PRAGMA table_info(ingest_keys)")
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notNull, primary int
		var name, typ string
		var defaultValue any
		if err = rows.Scan(&cid, &name, &typ, &notNull, &defaultValue, &primary); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, column := range []struct{ name, definition string }{
		{"allowed_tables_json", "TEXT NOT NULL DEFAULT '[]'"},
		{"allow_all_tables", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if !columns[column.name] {
			if _, err := db.Exec("ALTER TABLE ingest_keys ADD COLUMN " + column.name + " " + column.definition); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeKeyTablePermissions(tables []string, allowAll bool) ([]string, error) {
	if allowAll {
		return []string{}, nil
	}
	return normalizeAllowedTables(tables)
}

func normalizeAllowedTables(tables []string) ([]string, error) {
	if len(tables) == 0 || len(tables) > 200 {
		return nil, errors.New("请选择 1–200 个允许写入的逻辑 table")
	}
	unique := map[string]bool{}
	result := []string{}
	for _, table := range tables {
		table = strings.TrimSpace(table)
		if !shared.ValidLogicalTable(table) {
			return nil, fmt.Errorf("无效的逻辑 table: %q；使用小写字母开头的字母、数字或下划线，最长 48 位，不带 log_/metric_/trace_ 前缀", table)
		}
		if !unique[table] {
			result = append(result, table)
			unique[table] = true
		}
	}
	sort.Strings(result)
	return result, nil
}

func storedAllowedTables(raw string) []string {
	var tables []string
	if json.Unmarshal([]byte(raw), &tables) != nil {
		return []string{}
	}
	result, err := normalizeAllowedTables(tables)
	if err != nil {
		return []string{}
	}
	return result
}

func (a *Auth) AuthorizeTable(id, table string) error {
	if !shared.ValidLogicalTable(table) {
		return ErrTableNotAllowed
	}
	var raw string
	var allowAll bool
	if err := a.DB.QueryRow("SELECT allowed_tables_json,allow_all_tables FROM ingest_keys WHERE id=? AND active=1", id).Scan(&raw, &allowAll); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrTableNotAllowed
		}
		return err
	}
	if allowAll {
		return nil
	}
	for _, allowed := range storedAllowedTables(raw) {
		if table == allowed {
			return nil
		}
	}
	return ErrTableNotAllowed
}

type keyItem struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Active         bool     `json:"active"`
	CreatedAt      string   `json:"created_at"`
	LastUsed       string   `json:"last_used"`
	UploadBatches  int64    `json:"upload_batches"`
	ErrorCount     int64    `json:"error_count"`
	AllowedTables  []string `json:"allowed_tables"`
	AllowAllTables bool     `json:"allow_all_tables"`
}

func (a *Auth) registerKeys(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/keys", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		rows, err := a.DB.Query("SELECT id,name,active,created_at,COALESCE(last_used,''),upload_batches,error_count,allowed_tables_json,allow_all_tables FROM ingest_keys ORDER BY created_at DESC")
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		defer rows.Close()
		data := []keyItem{}
		for rows.Next() {
			var item keyItem
			var raw string
			if err = rows.Scan(&item.ID, &item.Name, &item.Active, &item.CreatedAt, &item.LastUsed, &item.UploadBatches, &item.ErrorCount, &raw, &item.AllowAllTables); err != nil {
				shared.Error(w, 500, err.Error())
				return
			}
			item.AllowedTables = storedAllowedTables(raw)
			data = append(data, item)
		}
		if err = rows.Err(); err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		shared.JSON(w, 200, data)
	})
	mux.HandleFunc("POST /api/v1/keys", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var v struct {
			Name           string   `json:"name"`
			AllowedTables  []string `json:"allowed_tables"`
			AllowAllTables bool     `json:"allow_all_tables"`
		}
		if shared.Decode(r, &v) != nil || strings.TrimSpace(v.Name) == "" {
			shared.Error(w, 400, "Key 名称必填")
			return
		}
		tables, err := normalizeKeyTablePermissions(v.AllowedTables, v.AllowAllTables)
		if err != nil {
			shared.Error(w, 400, err.Error())
			return
		}
		id, key := ID(), "lm_"+token()
		name := strings.TrimSpace(v.Name)
		_, err = a.DB.Exec("INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json,allow_all_tables) VALUES(?,?,?,?,?,?)", id, name, hash(key), time.Now().UTC().Format(time.RFC3339Nano), encoded(tables), v.AllowAllTables)
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		shared.JSON(w, 201, map[string]any{"id": id, "key": key, "name": name, "allowed_tables": tables, "allow_all_tables": v.AllowAllTables})
	})
	mux.HandleFunc("PUT /api/v1/keys/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var v struct {
			Name           *string   `json:"name"`
			Active         *bool     `json:"active"`
			AllowedTables  *[]string `json:"allowed_tables"`
			AllowAllTables *bool     `json:"allow_all_tables"`
		}
		if shared.Decode(r, &v) != nil {
			shared.Error(w, 400, "invalid key")
			return
		}
		tx, err := a.DB.Begin()
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		defer tx.Rollback()
		var name, raw string
		var active, allowAll bool
		err = tx.QueryRow("SELECT name,active,allowed_tables_json,allow_all_tables FROM ingest_keys WHERE id=?", r.PathValue("id")).Scan(&name, &active, &raw, &allowAll)
		if errors.Is(err, sql.ErrNoRows) {
			shared.Error(w, 404, "Key 不存在")
			return
		}
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		if v.Name != nil {
			name = strings.TrimSpace(*v.Name)
		}
		if name == "" {
			shared.Error(w, 400, "Key 名称必填")
			return
		}
		if v.Active != nil {
			active = *v.Active
		}
		if v.AllowAllTables != nil {
			allowAll = *v.AllowAllTables
		}
		if v.AllowedTables != nil || v.AllowAllTables != nil {
			tables := storedAllowedTables(raw)
			if v.AllowedTables != nil {
				tables = *v.AllowedTables
			}
			tables, err := normalizeKeyTablePermissions(tables, allowAll)
			if err != nil {
				shared.Error(w, 400, err.Error())
				return
			}
			raw = encoded(tables)
		}
		if v.Active != nil && active && !allowAll && len(storedAllowedTables(raw)) == 0 {
			shared.Error(w, 400, "启用 Key 前请先配置允许写入的 table")
			return
		}
		_, err = tx.Exec("UPDATE ingest_keys SET name=?,active=?,allowed_tables_json=?,allow_all_tables=? WHERE id=?", name, active, raw, allowAll, r.PathValue("id"))
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /api/v1/keys/{id}/events", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		rows, err := a.DB.Query("SELECT at,service,status,detail FROM key_events WHERE key_id=? ORDER BY id DESC LIMIT 200", r.PathValue("id"))
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		defer rows.Close()
		data := []any{}
		for rows.Next() {
			var at, service, status, detail string
			if err = rows.Scan(&at, &service, &status, &detail); err != nil {
				shared.Error(w, 500, err.Error())
				return
			}
			data = append(data, map[string]string{"at": at, "service": service, "status": status, "detail": detail})
		}
		if err = rows.Err(); err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		shared.JSON(w, 200, data)
	})
}
