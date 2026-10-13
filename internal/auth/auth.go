package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/lightmoni/lightmoni/internal/shared"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

type Auth struct {
	DB          *sql.DB
	Master      []byte
	ExternalURL string
}

func New(db *sql.DB, dir, externalURL string) (*Auth, error) {
	if _, e := db.Exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL DEFAULT '',role TEXT NOT NULL DEFAULT 'member',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ingest_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,last_used TEXT,upload_batches INTEGER NOT NULL DEFAULT 0,error_count INTEGER NOT NULL DEFAULT 0,allowed_tables_json TEXT NOT NULL DEFAULT '[]',allow_all_tables INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS key_events(id INTEGER PRIMARY KEY AUTOINCREMENT,key_id TEXT NOT NULL,at TEXT NOT NULL,service TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS oauth_providers(id TEXT PRIMARY KEY,config TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS external_identities(provider_id TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(provider_id,subject));
 CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,provider_id TEXT NOT NULL,verifier TEXT NOT NULL,created_at INTEGER NOT NULL,user_id TEXT NOT NULL DEFAULT '');`); e != nil {
		return nil, e
	}
	if e := migrateKeyTables(db); e != nil {
		return nil, e
	}
	if _, e := db.Exec("CREATE TABLE IF NOT EXISTS user_notification_profiles(user_id TEXT PRIMARY KEY,body TEXT NOT NULL)"); e != nil {
		return nil, e
	}
	if _, e := db.Exec("CREATE TABLE IF NOT EXISTS oauth_return_targets(state TEXT PRIMARY KEY,return_to TEXT NOT NULL)"); e != nil {
		return nil, e
	}
	path := filepath.Join(dir, "master.key")
	key, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		key = make([]byte, 32)
		if _, e = rand.Read(key); e == nil {
			e = os.WriteFile(path, key, 0600)
		}
	}
	if e != nil {
		return nil, e
	}
	if len(key) != 32 {
		return nil, errors.New("invalid master key")
	}
	return &Auth{DB: db, Master: key, ExternalURL: strings.TrimRight(externalURL, "/")}, nil
}
func validPassword(value string) bool { return utf8.RuneCountInString(value) >= 8 && len(value) <= 72 }
func ID() string                      { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func token() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func hash(s string) string { sum := sha256.Sum256([]byte(s)); return hex.EncodeToString(sum[:]) }
func (a *Auth) Encrypt(value string) (string, error) {
	b, e := aes.NewCipher(a.Master)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(b)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, g.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	return base64.StdEncoding.EncodeToString(g.Seal(nonce, nonce, []byte(value), nil)), nil
}
func (a *Auth) Decrypt(value string) (string, error) {
	raw, e := base64.StdEncoding.DecodeString(value)
	if e != nil {
		return "", e
	}
	b, e := aes.NewCipher(a.Master)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(b)
	if e != nil {
		return "", e
	}
	if len(raw) < g.NonceSize() {
		return "", errors.New("invalid encrypted value")
	}
	plain, e := g.Open(nil, raw[:g.NonceSize()], raw[g.NonceSize():], nil)
	return string(plain), e
}
func (a *Auth) session(w http.ResponseWriter, r *http.Request, id string) error {
	s := token()
	_, e := a.DB.Exec("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", hash(s), id, time.Now().Add(7*24*time.Hour).Unix())
	if e != nil {
		return e
	}
	http.SetCookie(w, &http.Cookie{Name: "lm_session", Value: s, Path: "/", HttpOnly: true, Secure: r.TLS != nil || strings.HasPrefix(a.ExternalURL, "https:"), SameSite: http.SameSiteLaxMode, MaxAge: 604800})
	return nil
}
func (a *Auth) User(r *http.Request) (shared.User, error) {
	cookie, e := r.Cookie("lm_session")
	if e != nil {
		return shared.User{}, e
	}
	var u shared.User
	e = a.DB.QueryRow("SELECT u.id,u.name,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1", hash(cookie.Value), time.Now().Unix()).Scan(&u.ID, &u.Name, &u.Role)
	return u, e
}
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, e := a.User(r)
		if e != nil {
			shared.Error(w, 401, "请先登录")
			return
		}
		if !a.checkOrigin(w, r) {
			return
		}

		next.ServeHTTP(w, r.WithContext(shared.WithUser(r.Context(), u)))
	})
}
func (a *Auth) checkOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == "GET" || r.Method == "HEAD" || r.Method == "OPTIONS" {
		return true
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	expected := a.ExternalURL
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		expected = scheme + "://" + r.Host
	}
	expectedURL, _ := url.Parse(expected)
	local := expectedURL != nil && (expectedURL.Hostname() == "localhost" || expectedURL.Hostname() == "127.0.0.1")
	if origin != expected && !(local && (origin == "http://127.0.0.1:5173" || origin == "http://localhost:5173")) {
		shared.Error(w, 403, "invalid request origin")
		return false
	}
	return true
}
func admin(w http.ResponseWriter, r *http.Request) bool {
	if !shared.IsAdmin(r) {
		shared.Error(w, 403, "需要管理员权限")
		return false
	}
	return true
}
func (a *Auth) ValidateKey(r *http.Request) (string, error) {
	value := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	var id string
	e := a.DB.QueryRow("SELECT id FROM ingest_keys WHERE token_hash=? AND active=1", hash(value)).Scan(&id)
	if e == nil {
		_, _ = a.DB.Exec("UPDATE ingest_keys SET last_used=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), id)
	}
	return id, e
}
func (a *Auth) RecordKey(id, service, status, detail string) {
	if id == "" {
		return
	}
	if len(detail) > 1000 {
		detail = detail[:1000]
	}
	_, _ = a.DB.Exec("INSERT INTO key_events(key_id,at,service,status,detail) VALUES(?,?,?,?,?)", id, time.Now().UTC().Format(time.RFC3339Nano), service, status, detail)
	column := "upload_batches"
	if status != "accepted" {
		column = "error_count"
	}
	_, _ = a.DB.Exec("UPDATE ingest_keys SET "+column+"="+column+"+1 WHERE id=?", id)
	_, _ = a.DB.Exec("DELETE FROM key_events WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM key_events)")
}
func (a *Auth) RegisterPublic(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/setup", func(w http.ResponseWriter, r *http.Request) {
		var n int
		_ = a.DB.QueryRow("SELECT count(*) FROM users").Scan(&n)
		shared.JSON(w, 200, map[string]bool{"required": n == 0})
	})
	mux.HandleFunc("POST /api/v1/setup", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkOrigin(w, r) {
			return
		}
		var v struct {
			Name     string `json:"name"`
			Password string `json:"password"`
		}
		if shared.Decode(r, &v) != nil || len(v.Name) < 1 || !validPassword(v.Password) {
			shared.Error(w, 400, "名称和8个字符到72字节密码必填")
			return
		}
		h, hashErr := bcrypt.GenerateFromPassword([]byte(v.Password), bcrypt.DefaultCost)
		if hashErr != nil {
			shared.Error(w, 400, "密码至少8个字符，最多72字节")
			return
		}
		tx, e := a.DB.Begin()
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		defer tx.Rollback()
		var n int
		if e = tx.QueryRow("SELECT count(*) FROM users").Scan(&n); e != nil || n != 0 {
			shared.Error(w, 409, "已经初始化")
			return
		}
		id := ID()
		_, e = tx.Exec("INSERT INTO users(id,name,password_hash,role,active,created_at) VALUES(?,?,?,'admin',1,?)", id, v.Name, string(h), time.Now().UTC().Format(time.RFC3339Nano))
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		if e = a.session(w, r, id); e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 201, shared.User{ID: id, Name: v.Name, Role: "admin"})
	})
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkOrigin(w, r) {
			return
		}
		var v struct{ Name, Password string }
		if shared.Decode(r, &v) != nil {
			shared.Error(w, 400, "invalid login")
			return
		}
		var u shared.User
		var h string
		e := a.DB.QueryRow("SELECT id,name,role,password_hash FROM users WHERE name=? AND active=1", v.Name).Scan(&u.ID, &u.Name, &u.Role, &h)
		if e != nil || bcrypt.CompareHashAndPassword([]byte(h), []byte(v.Password)) != nil {
			shared.Error(w, 401, "用户名或密码错误")
			return
		}
		if e = a.session(w, r, u.ID); e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 200, u)
	})
	mux.HandleFunc("POST /api/v1/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		if !a.checkOrigin(w, r) {
			return
		}
		if c, e := r.Cookie("lm_session"); e == nil {
			_, _ = a.DB.Exec("DELETE FROM sessions WHERE token_hash=?", hash(c.Value))
		}
		http.SetCookie(w, &http.Cookie{Name: "lm_session", Path: "/", MaxAge: -1, HttpOnly: true})
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	a.registerOAuthPublic(mux)
}
func (a *Auth) Register(mux *http.ServeMux) {
	a.registerNotificationProfiles(mux)
	mux.HandleFunc("GET /api/v1/auth/me", func(w http.ResponseWriter, r *http.Request) { shared.JSON(w, 200, shared.CurrentUser(r)) })
	mux.HandleFunc("GET /api/v1/users", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		rows, e := a.DB.Query("SELECT id,name,role,active,created_at FROM users ORDER BY created_at")
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		defer rows.Close()
		data := []any{}
		for rows.Next() {
			var id, name, role, created string
			var active bool
			_ = rows.Scan(&id, &name, &role, &active, &created)
			data = append(data, map[string]any{"id": id, "name": name, "role": role, "active": active, "created_at": created})
		}
		shared.JSON(w, 200, data)
	})
	mux.HandleFunc("POST /api/v1/users", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var v struct {
			Name     string `json:"name"`
			Password string `json:"password"`
			Role     string `json:"role"`
		}
		if shared.Decode(r, &v) != nil || v.Name == "" || !validPassword(v.Password) || (v.Role != "member" && v.Role != "admin") {
			shared.Error(w, 400, "用户名、角色及8个字符到72字节密码必填")
			return
		}
		h, hashErr := bcrypt.GenerateFromPassword([]byte(v.Password), bcrypt.DefaultCost)
		if hashErr != nil {
			shared.Error(w, 400, "密码至少8个字符，最多72字节")
			return
		}
		id := ID()
		_, e := a.DB.Exec("INSERT INTO users(id,name,password_hash,role,active,created_at) VALUES(?,?,?,?,1,?)", id, v.Name, string(h), v.Role, time.Now().UTC().Format(time.RFC3339Nano))
		if e != nil {
			shared.Error(w, 409, "用户名已存在")
			return
		}
		shared.JSON(w, 201, map[string]string{"id": id})
	})
	mux.HandleFunc("PUT /api/v1/users/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var v struct {
			Name     string `json:"name"`
			Role     string `json:"role"`
			Active   bool   `json:"active"`
			Password string `json:"password"`
		}
		if shared.Decode(r, &v) != nil || v.Name == "" || (v.Role != "member" && v.Role != "admin") || v.Password != "" && !validPassword(v.Password) {
			shared.Error(w, 400, "invalid user")
			return
		}
		id := r.PathValue("id")
		tx, e := a.DB.Begin()
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		defer tx.Rollback()
		var oldRole string
		var oldActive bool
		if e = tx.QueryRow("SELECT role,active FROM users WHERE id=?", id).Scan(&oldRole, &oldActive); e != nil {
			shared.Error(w, 404, "user not found")
			return
		}
		if oldRole == "admin" && oldActive && (!v.Active || v.Role != "admin") {
			var n int
			_ = tx.QueryRow("SELECT count(*) FROM users WHERE role='admin' AND active=1").Scan(&n)
			if n < 2 {
				shared.Error(w, 409, "不能禁用或降级最后一个管理员")
				return
			}
		}
		_, e = tx.Exec("UPDATE users SET name=?,role=?,active=? WHERE id=?", v.Name, v.Role, v.Active, id)
		if v.Password != "" && e == nil {
			h, hashErr := bcrypt.GenerateFromPassword([]byte(v.Password), bcrypt.DefaultCost)
			if hashErr != nil {
				shared.Error(w, 400, "密码至少8个字符，最多72字节")
				return
			}
			_, e = tx.Exec("UPDATE users SET password_hash=? WHERE id=?", string(h), id)
		}
		if e == nil {
			_, e = tx.Exec("DELETE FROM sessions WHERE user_id=?", id)
		}
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			shared.Error(w, 409, e.Error())
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	a.registerKeys(mux)
	a.registerOAuthAdmin(mux)
}
func encoded(v any) string { b, _ := json.Marshal(v); return string(b) }
