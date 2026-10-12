package server

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/storage"
)

func reportingTestServer(t *testing.T, path, externalURL string) *Server {
	t.Helper()
	db, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	s := &Server{DB: db, API: http.NewServeMux(), Public: http.NewServeMux()}
	if err := s.registerAgentInstall(externalURL); err != nil {
		t.Fatal(err)
	}
	return s
}

func readReportingSettings(t *testing.T, s *Server) reportingSettings {
	t.Helper()
	w := groupRequest(t, s, false, "member", "GET", "/api/v1/settings/reporting", nil)
	var settings reportingSettings
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &settings) != nil {
		t.Fatalf("read reporting settings: %d %s", w.Code, w.Body)
	}
	return settings
}

func TestReportingDefaultPersistenceAndInstallMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reporting.db")
	s := reportingTestServer(t, path, "https://public.example/lightmoni/")
	settings := readReportingSettings(t, s)
	if settings.Endpoint != "" || settings.EffectiveEndpoint != "https://public.example/lightmoni" {
		t.Fatalf("deployment fallback: %+v", settings)
	}
	endpoint := "http://10.0.0.8:8080/monitor"
	w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", map[string]string{"endpoint": "  " + endpoint + "///  "})
	if w.Code != 200 || readReportingSettings(t, s).EffectiveEndpoint != endpoint {
		t.Fatalf("save reporting address: %d %s", w.Code, w.Body)
	}
	for _, route := range []string{"/api/v1/sdk-install", "/api/v1/agent-install"} {
		w = groupRequest(t, s, false, "member", "GET", route, nil)
		var metadata map[string]any
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &metadata) != nil || metadata["endpoint"] != endpoint {
			t.Fatalf("install default %s: %d %s", route, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), "public.example") {
			t.Fatalf("download URLs did not follow the saved default: %s", w.Body)
		}
		if route == "/api/v1/agent-install" && (metadata["install_url"] != endpoint+"/downloads/agent/install.sh" || metadata["release_url"] != endpoint+"/downloads/agent") {
			t.Fatalf("Agent download paths: %s", w.Body)
		}
		if route == "/api/v1/sdk-install" {
			for _, item := range metadata["packages"].([]any) {
				p := item.(map[string]any)
				if p["url"] != endpoint+"/downloads/sdk/"+p["file"].(string) {
					t.Fatalf("SDK download path: %v", p)
				}
			}
		}
	}
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	restarted := reportingTestServer(t, path, "https://new-public.example/")
	settings = readReportingSettings(t, restarted)
	if settings.Endpoint != endpoint || settings.EffectiveEndpoint != endpoint || settings.DefaultEndpoint != "https://new-public.example" {
		t.Fatalf("saved address after restart: %+v", settings)
	}
	w = groupRequest(t, restarted, false, "admin", "PUT", "/api/v1/settings/reporting", map[string]string{"endpoint": ""})
	if w.Code != 200 || readReportingSettings(t, restarted).EffectiveEndpoint != "https://new-public.example" {
		t.Fatalf("restore deployment fallback: %d %s", w.Code, w.Body)
	}
}

func TestReportingPermissionsAndValidation(t *testing.T) {
	s := reportingTestServer(t, filepath.Join(t.TempDir(), "reporting.db"), "https://public.example")
	w := groupRequest(t, s, false, "member", "PUT", "/api/v1/settings/reporting", map[string]string{"endpoint": "https://other.example"})
	if w.Code != 403 {
		t.Fatalf("member update: %d %s", w.Code, w.Body)
	}
	for _, input := range []any{
		map[string]any{}, map[string]any{"endpoint": nil}, map[string]any{"endpoint": 42},
		map[string]string{"endpoint": "ftp://center"}, map[string]string{"endpoint": "https://user:password@center"},
		map[string]string{"endpoint": "http://center/?key=value"}, map[string]string{"endpoint": "http://center/?"},
		map[string]string{"endpoint": "http://center/#"}, map[string]string{"endpoint": "http://:8080"},
		map[string]string{"endpoint": "http://center\\path"}, map[string]string{"endpoint": "https://center/" + strings.Repeat("a", 2048)},
	} {
		w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", input)
		if w.Code != 400 || readReportingSettings(t, s).EffectiveEndpoint != "https://public.example" {
			t.Fatalf("invalid update %v: %d %s", input, w.Code, w.Body)
		}
	}
	for _, endpoint := range []string{"https://monitor.example", "http://center:8080/base", "http://10.0.0.2:8080", "http://[::1]:8080/base"} {
		w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", map[string]string{"endpoint": endpoint})
		if w.Code != 200 {
			t.Fatalf("valid update %s: %d %s", endpoint, w.Code, w.Body)
		}
	}
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/api/v1/settings/reporting", "/api/v1/sdk-install", "/api/v1/agent-install"} {
		if w = groupRequest(t, s, false, "member", "GET", route, nil); w.Code != 500 {
			t.Fatalf("unavailable settings %s: %d %s", route, w.Code, w.Body)
		}
	}
}
