package auth

import (
	"bytes"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/storage"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func testAuth(t *testing.T) (*Auth, *httptest.Server, *http.Client) {
	t.Helper()
	dir := t.TempDir()
	db, e := storage.Open(filepath.Join(dir, "auth.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	a, e := New(db, dir, "http://localhost")
	if e != nil {
		t.Fatal(e)
	}
	public, private := http.NewServeMux(), http.NewServeMux()
	a.RegisterPublic(public)
	a.Register(private)
	protected := a.Middleware(private)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, p := public.Handler(r); p != "" {
			public.ServeHTTP(w, r)
		} else {
			protected.ServeHTTP(w, r)
		}
	}))
	t.Cleanup(s.Close)
	a.ExternalURL = s.URL
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return a, s, client
}
func authRequest(t *testing.T, c *http.Client, method, endpoint string, value any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(value)
	req, _ := http.NewRequest(method, endpoint, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	response, e := c.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer response.Body.Close()
	var result map[string]any
	_ = json.NewDecoder(response.Body).Decode(&result)
	return response.StatusCode, result
}
func TestScopedKeyAndUserLifecycle(t *testing.T) {
	a, s, c := testAuth(t)
	status, admin := authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatalf("setup %d %v", status, admin)
	}
	status, _ = authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "second", "password": "password123"})
	if status != 409 {
		t.Fatal("setup repeated")
	}
	status, key := authRequest(t, c, "POST", s.URL+"/api/v1/keys", map[string]any{"name": "scoped", "allowed_tables": []string{"app"}})
	if status != 201 {
		t.Fatal(key)
	}
	for _, service := range []string{"api", "worker"} {
		r := httptest.NewRequest("POST", "/v1/logs", nil)
		r.Header.Set("Authorization", "Bearer "+key["key"].(string))
		id, e := a.ValidateKey(r)
		if e != nil || id != key["id"] {
			t.Fatalf("%s rejected: %v", service, e)
		}
		a.RecordKey(id, service, "accepted", "")
	}
	status, _ = authRequest(t, c, "PUT", s.URL+"/api/v1/keys/"+key["id"].(string), map[string]any{"name": "scoped", "active": false})
	if status != 200 {
		t.Fatal(status)
	}
	r := httptest.NewRequest("POST", "/v1/logs", nil)
	r.Header.Set("Authorization", "Bearer "+key["key"].(string))
	if _, e := a.ValidateKey(r); e == nil {
		t.Fatal("disabled key accepted")
	}
	status, member := authRequest(t, c, "POST", s.URL+"/api/v1/users", map[string]any{"name": "member", "password": "password123", "role": "member"})
	if status != 201 {
		t.Fatalf("member %d %v", status, member)
	}
	jar, _ := cookiejar.New(nil)
	mc := &http.Client{Jar: jar}
	status, _ = authRequest(t, mc, "POST", s.URL+"/api/v1/auth/login", map[string]string{"name": "member", "password": "password123"})
	if status != 200 {
		t.Fatal("member login")
	}
	status, _ = authRequest(t, mc, "POST", s.URL+"/api/v1/keys", map[string]string{"name": "unauthorized"})
	if status != 403 {
		t.Fatal("member can create key")
	}
	status, _ = authRequest(t, mc, "PUT", s.URL+"/api/v1/keys/"+key["id"].(string), map[string]any{"allowed_tables": []string{"host"}, "allow_all_tables": true, "active": true})
	if status != 403 {
		t.Fatal("member can expand key permissions")
	}
	status, _ = authRequest(t, mc, "GET", s.URL+"/api/v1/keys", nil)
	if status != 403 {
		t.Fatal("member can list private keys")
	}
	status, _ = authRequest(t, c, "PUT", s.URL+"/api/v1/users/"+member["id"].(string), map[string]any{"name": "member", "role": "member", "active": false})
	if status != 200 {
		t.Fatal(status)
	}
	status, _ = authRequest(t, mc, "GET", s.URL+"/api/v1/auth/me", nil)
	if status != 401 {
		t.Fatal("disabled session still usable")
	}
	status, _ = authRequest(t, c, "PUT", s.URL+"/api/v1/users/"+admin["id"].(string), map[string]any{"name": "admin", "role": "member", "active": true})
	if status != 409 {
		t.Fatalf("last admin protection %d", status)
	}
}
func TestOAuthPKCEStateAndStableIdentity(t *testing.T) {
	a, s, c := testAuth(t)
	authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	var verifier string
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			verifier = r.Form.Get("code_verifier")
			if verifier == "" || r.Form.Get("client_secret") != "secret" {
				t.Error("PKCE/secret missing")
			}
			_, _ = io.WriteString(w, `{"access_token":"fixture-token"}`)
		case "/user":
			if r.Header.Get("Authorization") != "Bearer fixture-token" {
				t.Error("token missing")
			}
			_, _ = io.WriteString(w, `{"id":18446744073709551615,"name":"remote-user","email":"admin@example.test"}`)
		}
	}))
	defer provider.Close()
	config := Provider{Name: "Fixture", Kind: "oauth2", Enabled: true, ClientID: "client", Secret: "secret", AuthorizeURL: provider.URL + "/authorize", TokenURL: provider.URL + "/token", UserInfoURL: provider.URL + "/user", SubjectField: "id", NameField: "name", PKCE: true, AutoApprove: true}
	status, _ := authRequest(t, c, "PUT", s.URL+"/api/v1/settings/login-providers/fixture", config)
	if status != 200 {
		t.Fatal(status)
	}
	var persisted string
	_ = a.DB.QueryRow("SELECT config FROM oauth_providers WHERE id='fixture'").Scan(&persisted)
	if strings.Contains(persisted, `"client_secret":"secret"`) {
		t.Fatal("secret stored plaintext")
	}
	start, e := c.Get(s.URL + "/api/v1/auth/oauth/fixture/start")
	if e != nil {
		t.Fatal(e)
	}
	defer start.Body.Close()
	redirect, _ := url.Parse(start.Header.Get("Location"))
	state := redirect.Query().Get("state")
	challenge := redirect.Query().Get("code_challenge")
	if start.StatusCode != 302 || state == "" || challenge == "" {
		t.Fatal("missing state/PKCE")
	}
	callback := s.URL + "/api/v1/auth/oauth/fixture/callback?state=" + url.QueryEscape(state) + "&code=fixture-code"
	response, e := c.Get(callback)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.Header.Get("Location") != "/" || verifier == "" {
		t.Fatalf("OAuth failed: %s", response.Header.Get("Location"))
	}
	var subject, userID string
	_ = a.DB.QueryRow("SELECT subject,user_id FROM external_identities WHERE provider_id='fixture'").Scan(&subject, &userID)
	if subject != "18446744073709551615" || userID == "" {
		t.Fatalf("identity changed: %s", subject)
	}
	response, e = c.Get(callback)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if !strings.Contains(response.Header.Get("Location"), "oauth_error") {
		t.Fatal("callback replay accepted")
	}
	status, me := authRequest(t, c, "GET", s.URL+"/api/v1/auth/me", nil)
	if status != 200 || me["id"] != userID || me["role"] != "member" {
		t.Fatalf("unverified email merged account: %v", me)
	}
}

func TestPasswordByteLimitNeverRevokesValidAdmin(t *testing.T) {
	a, s, c := testAuth(t)
	status, _ := authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": strings.Repeat("a", 73)})
	if status != 400 {
		t.Fatal("oversized setup accepted")
	}
	var count int
	_ = a.DB.QueryRow("SELECT count(*) FROM users").Scan(&count)
	if count != 0 {
		t.Fatal("bad setup stored user")
	}
	status, admin := authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": strings.Repeat("密", 24)})
	if status != 201 {
		t.Fatal("valid 72 byte UTF8 password rejected")
	}
	status, _ = authRequest(t, c, "PUT", s.URL+"/api/v1/users/"+admin["id"].(string), map[string]any{"name": "changed", "role": "admin", "active": true, "password": strings.Repeat("密", 25)})
	if status != 400 {
		t.Fatal("oversized update accepted")
	}
	status, me := authRequest(t, c, "GET", s.URL+"/api/v1/auth/me", nil)
	if status != 200 || me["name"] != "admin" {
		t.Fatal("bad update changed account or revoked session")
	}
	status, _ = authRequest(t, c, "POST", s.URL+"/api/v1/users", map[string]any{"name": "bad", "role": "member", "password": strings.Repeat("a", 73)})
	if status != 400 {
		t.Fatal("oversized member password accepted")
	}
}
