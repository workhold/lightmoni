package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Provider struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Enabled      bool   `json:"enabled"`
	ClientID     string `json:"client_id"`
	Secret       string `json:"client_secret,omitempty"`
	AuthorizeURL string `json:"authorize_url"`
	TokenURL     string `json:"token_url"`
	UserInfoURL  string `json:"userinfo_url"`
	SubjectField string `json:"subject_field"`
	NameField    string `json:"name_field"`
	Scopes       string `json:"scopes"`
	PKCE         bool   `json:"pkce"`
	AutoApprove  bool   `json:"auto_approve"`
}

func defaults(p Provider) Provider {
	switch p.Kind {
	case "github":
		p.AuthorizeURL = "https://github.com/login/oauth/authorize"
		p.TokenURL = "https://github.com/login/oauth/access_token"
		p.UserInfoURL = "https://api.github.com/user"
		p.SubjectField = "id"
		p.NameField = "login"
		p.PKCE = true
	case "qq":
		p.AuthorizeURL = "https://graph.qq.com/oauth2.0/authorize"
		p.TokenURL = "https://graph.qq.com/oauth2.0/token"
		p.UserInfoURL = "https://graph.qq.com/oauth2.0/me"
		p.SubjectField = "openid"
		p.NameField = "openid"
		p.Scopes = "get_user_info"
	case "wechat":
		p.AuthorizeURL = "https://open.weixin.qq.com/connect/qrconnect"
		p.TokenURL = "https://api.weixin.qq.com/sns/oauth2/access_token"
		p.UserInfoURL = "https://api.weixin.qq.com/sns/userinfo"
		p.SubjectField = "openid"
		p.NameField = "nickname"
		p.Scopes = "snsapi_login"
	}
	return p
}
func (a *Auth) providers(includeSecret bool) ([]Provider, error) {
	rows, e := a.DB.Query("SELECT config FROM oauth_providers ORDER BY id")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	list := []Provider{}
	for rows.Next() {
		var raw string
		_ = rows.Scan(&raw)
		var p Provider
		if e = json.Unmarshal([]byte(raw), &p); e != nil {
			return nil, e
		}
		if includeSecret {
			p.Secret, e = a.Decrypt(p.Secret)
			if e != nil {
				return nil, e
			}
		} else {
			p.Secret = ""
		}
		list = append(list, p)
	}
	return list, rows.Err()
}
func (a *Auth) provider(id string) (Provider, error) {
	all, e := a.providers(true)
	if e != nil {
		return Provider{}, e
	}
	for _, p := range all {
		if p.ID == id && p.Enabled {
			return p, nil
		}
	}
	return Provider{}, fmt.Errorf("login provider unavailable")
}
func (a *Auth) registerOAuthAdmin(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/settings/login-providers", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		all, e := a.providers(false)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 200, all)
	})
	m.HandleFunc("PUT /api/v1/settings/login-providers/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var p Provider
		if shared.Decode(r, &p) != nil {
			shared.Error(w, 400, "invalid provider")
			return
		}
		p.ID = r.PathValue("id")
		if p.Kind != "github" && p.Kind != "qq" && p.Kind != "wechat" && p.Kind != "oauth2" {
			shared.Error(w, 400, "unsupported provider")
			return
		}
		p = defaults(p)
		if p.Name == "" || p.ClientID == "" || p.AuthorizeURL == "" || p.TokenURL == "" || p.UserInfoURL == "" || p.SubjectField == "" {
			shared.Error(w, 400, "完整供应商配置必填")
			return
		}
		for _, raw := range []string{p.AuthorizeURL, p.TokenURL, p.UserInfoURL} {
			u, e := url.Parse(raw)
			if e != nil || u.Host == "" || u.Scheme != "https" && u.Scheme != "http" {
				shared.Error(w, 400, "invalid provider endpoint")
				return
			}
		}
		if p.Secret == "" {
			var old string
			if a.DB.QueryRow("SELECT config FROM oauth_providers WHERE id=?", p.ID).Scan(&old) == nil {
				var existing Provider
				_ = json.Unmarshal([]byte(old), &existing)
				p.Secret = existing.Secret
			}
		} else {
			encrypted, e := a.Encrypt(p.Secret)
			if e != nil {
				shared.Error(w, 500, e.Error())
				return
			}
			p.Secret = encrypted
		}
		if p.Secret == "" {
			shared.Error(w, 400, "Client secret必填")
			return
		}
		_, e := a.DB.Exec("INSERT INTO oauth_providers(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config", p.ID, encoded(p))
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		p.Secret = ""
		shared.JSON(w, 200, p)
	})
	m.HandleFunc("DELETE /api/v1/settings/login-providers/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		_, e := a.DB.Exec("DELETE FROM oauth_providers WHERE id=?", r.PathValue("id"))
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	m.HandleFunc("GET /api/v1/auth/identities", func(w http.ResponseWriter, r *http.Request) {
		rows, e := a.DB.Query("SELECT provider_id,subject FROM external_identities WHERE user_id=?", shared.CurrentUser(r).ID)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		defer rows.Close()
		list := []any{}
		for rows.Next() {
			var p, s string
			_ = rows.Scan(&p, &s)
			list = append(list, map[string]string{"provider_id": p, "subject": s})
		}
		shared.JSON(w, 200, list)
	})
}
func (a *Auth) registerOAuthPublic(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/auth/providers", func(w http.ResponseWriter, r *http.Request) {
		all, e := a.providers(false)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		list := []any{}
		for _, p := range all {
			if p.Enabled {
				list = append(list, map[string]string{"id": p.ID, "name": p.Name, "kind": p.Kind})
			}
		}
		shared.JSON(w, 200, list)
	})
	m.HandleFunc("GET /api/v1/auth/oauth/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		p, e := a.provider(r.PathValue("id"))
		if e != nil {
			shared.Error(w, 404, e.Error())
			return
		}
		state, verifier := token(), token()
		userID := ""
		if r.URL.Query().Get("bind") == "1" {
			user, e := a.User(r)
			if e != nil {
				shared.Error(w, 401, "绑定需要先登录")
				return
			}
			userID = user.ID
		}
		_, e = a.DB.Exec("INSERT INTO oauth_states(state,provider_id,verifier,created_at,user_id) VALUES(?,?,?,?,?)", state, p.ID, verifier, time.Now().Unix(), userID)
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		_, _ = a.DB.Exec("DELETE FROM oauth_states WHERE created_at<?", time.Now().Add(-10*time.Minute).Unix())
		http.SetCookie(w, &http.Cookie{Name: "lm_oauth_state", Value: state, Path: "/api/v1/auth/oauth", HttpOnly: true, Secure: strings.HasPrefix(a.ExternalURL, "https:"), SameSite: http.SameSiteLaxMode, MaxAge: 600})
		u, _ := url.Parse(p.AuthorizeURL)
		q := u.Query()
		q.Set("response_type", "code")
		q.Set("client_id", p.ClientID)
		q.Set("redirect_uri", a.ExternalURL+"/api/v1/auth/oauth/"+p.ID+"/callback")
		q.Set("state", state)
		if p.Scopes != "" {
			q.Set("scope", p.Scopes)
		}
		if p.PKCE {
			sum := sha256.Sum256([]byte(verifier))
			q.Set("code_challenge", base64.RawURLEncoding.EncodeToString(sum[:]))
			q.Set("code_challenge_method", "S256")
		}
		if p.Kind == "wechat" {
			q.Del("client_id")
			q.Set("appid", p.ClientID)
		}
		u.RawQuery = q.Encode()
		if p.Kind == "wechat" {
			u.Fragment = "wechat_redirect"
		}
		http.Redirect(w, r, u.String(), 302)
	})
	m.HandleFunc("GET /api/v1/auth/oauth/{id}/callback", func(w http.ResponseWriter, r *http.Request) {
		fail := func(message string) { http.Redirect(w, r, "/login?oauth_error="+url.QueryEscape(message), 302) }
		state := r.URL.Query().Get("state")
		cookie, e := r.Cookie("lm_oauth_state")
		if e != nil || state == "" || cookie.Value != state {
			fail("登录状态无效，请重试")
			return
		}
		var providerID, verifier, userID string
		var created int64
		tx, e := a.DB.Begin()
		if e != nil {
			fail("存储不可用")
			return
		}
		e = tx.QueryRow("SELECT provider_id,verifier,created_at,user_id FROM oauth_states WHERE state=?", state).Scan(&providerID, &verifier, &created, &userID)
		if e == nil {
			_, e = tx.Exec("DELETE FROM oauth_states WHERE state=?", state)
		}
		if e == nil {
			e = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if e != nil || created < time.Now().Add(-10*time.Minute).Unix() || providerID != r.PathValue("id") {
			fail("登录回调已过期")
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			fail("已取消第三方授权")
			return
		}
		p, e := a.provider(providerID)
		if e != nil {
			fail("登录供应商不可用")
			return
		}
		identity, e := a.identity(r, p, code, verifier)
		if e != nil {
			fail(e.Error())
			return
		}
		subject := field(identity, p.SubjectField)
		if subject == "" {
			fail("供应商未返回稳定身份")
			return
		}
		if userID != "" {
			u, e := a.User(r)
			if e != nil || u.ID != userID {
				fail("绑定会话已变化")
				return
			}
			_, e = a.DB.Exec("INSERT INTO external_identities(provider_id,subject,user_id) VALUES(?,?,?)", providerID, subject, userID)
			if e != nil {
				fail("该外部身份已绑定")
				return
			}
			http.Redirect(w, r, "/settings?tab=users", 302)
			return
		}
		var id string
		e = a.DB.QueryRow("SELECT user_id FROM external_identities WHERE provider_id=? AND subject=?", providerID, subject).Scan(&id)
		if e != nil {
			id = ID()
			name := field(identity, p.NameField)
			if name == "" {
				name = p.Name
			}
			name = name + "-" + id[:6]
			tx, e := a.DB.Begin()
			if e != nil {
				fail("存储不可用")
				return
			}
			_, e = tx.Exec("INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,'member',?,?)", id, name, p.AutoApprove, time.Now().UTC().Format(time.RFC3339Nano))
			if e == nil {
				_, e = tx.Exec("INSERT INTO external_identities(provider_id,subject,user_id) VALUES(?,?,?)", providerID, subject, id)
			}
			if e == nil {
				e = tx.Commit()
			} else {
				_ = tx.Rollback()
			}
			if e != nil {
				fail("身份绑定失败，请重试")
				return
			}
		}
		var active bool
		if a.DB.QueryRow("SELECT active FROM users WHERE id=?", id).Scan(&active) != nil || !active {
			fail("账号等待管理员启用")
			return
		}
		if e = a.session(w, r, id); e != nil {
			fail("创建登录会话失败")
			return
		}
		http.Redirect(w, r, "/", 302)
	})
}
func field(value map[string]any, path string) string {
	var v any = value
	for _, p := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return ""
		}
		v = m[p]
	}
	if v == nil {
		return ""
	}
	return fmt.Sprint(v)
}
func providerRequest(r *http.Request, method, endpoint string, form url.Values, accessToken string) (map[string]any, error) {
	var body io.Reader
	if method == "GET" {
		u, _ := url.Parse(endpoint)
		q := u.Query()
		for k, v := range form {
			q[k] = v
		}
		u.RawQuery = q.Encode()
		endpoint = u.String()
	} else {
		body = strings.NewReader(form.Encode())
	}
	req, e := http.NewRequestWithContext(r.Context(), method, endpoint, body)
	if e != nil {
		return nil, fmt.Errorf("invalid provider request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	res, e := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if e != nil {
		return nil, fmt.Errorf("供应商网络请求失败")
	}
	defer res.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if e != nil || res.StatusCode >= 300 {
		return nil, fmt.Errorf("供应商返回错误 (%d)", res.StatusCode)
	}
	if start := strings.IndexByte(string(raw), '{'); start >= 0 {
		end := strings.LastIndexByte(string(raw), '}')
		var value map[string]any
		d := json.NewDecoder(strings.NewReader(string(raw[start : end+1])))
		d.UseNumber()
		if d.Decode(&value) == nil {
			return value, nil
		}
	}
	params, e := url.ParseQuery(string(raw))
	if e != nil {
		return nil, fmt.Errorf("供应商响应格式无效")
	}
	value := map[string]any{}
	for k, v := range params {
		if len(v) > 0 {
			value[k] = v[0]
		}
	}
	return value, nil
}
func (a *Auth) identity(r *http.Request, p Provider, code, verifier string) (map[string]any, error) {
	form := url.Values{"client_id": {p.ClientID}, "client_secret": {p.Secret}, "grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {a.ExternalURL + "/api/v1/auth/oauth/" + p.ID + "/callback"}}
	if p.PKCE {
		form.Set("code_verifier", verifier)
	}
	method := "POST"
	if p.Kind == "qq" || p.Kind == "wechat" {
		method = "GET"
	}
	if p.Kind == "wechat" {
		form.Del("client_id")
		form.Del("client_secret")
		form.Set("appid", p.ClientID)
		form.Set("secret", p.Secret)
	}
	response, e := providerRequest(r, method, p.TokenURL, form, "")
	if e != nil {
		return nil, e
	}
	access := field(response, "access_token")
	if access == "" {
		return nil, fmt.Errorf("供应商未返回有效授权")
	}
	params := url.Values{}
	if p.Kind == "qq" {
		params.Set("access_token", access)
	}
	if p.Kind == "wechat" {
		params.Set("access_token", access)
		params.Set("openid", field(response, "openid"))
		params.Set("lang", "zh_CN")
	}
	identity, e := providerRequest(r, "GET", p.UserInfoURL, params, access)
	if e != nil {
		return nil, e
	}
	return identity, nil
}
