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

func TestMultipleReportingAddressesAndLegacyMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reporting.db")
	s := reportingTestServer(t, path, "https://deployment.example/base")
	if _, err := s.DB.Exec("INSERT INTO instance_settings(name,value) VALUES('reporting_endpoint','https://legacy.example')"); err != nil {
		t.Fatal(err)
	}
	legacy := readReportingSettings(t, s)
	if len(legacy.Endpoints) != 1 || legacy.Endpoints[0].URL != "https://legacy.example" || legacy.DefaultEndpointID != legacy.Endpoints[0].ID {
		t.Fatal("legacy migration", legacy)
	}
	book := reportingAddressBook{Endpoints: []reportingAddress{{ID: "public", Name: "公网", URL: " https://public.example/base/// "}, {ID: "private", Name: "内网", URL: "http://10.0.0.8:8080/monitor"}}, DefaultEndpointID: "private"}
	w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", book)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	settings := readReportingSettings(t, s)
	if len(settings.Endpoints) != 2 || settings.EffectiveEndpoint != book.Endpoints[1].URL || settings.Endpoints[0].URL != "https://public.example/base" {
		t.Fatal(settings)
	}
	for _, path := range []string{"/api/v1/agent-install", "/api/v1/sdk-install"} {
		w = groupRequest(t, s, false, "member", "GET", path, nil)
		var metadata struct {
			Endpoint          string             `json:"endpoint"`
			Endpoints         []reportingAddress `json:"endpoints"`
			DefaultEndpointID string             `json:"default_endpoint_id"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &metadata) != nil || len(metadata.Endpoints) != 2 || metadata.DefaultEndpointID != "private" || metadata.Endpoint != book.Endpoints[1].URL {
			t.Fatal(path, w.Code, w.Body)
		}
	}
	if err := s.DB.Close(); err != nil {
		t.Fatal(err)
	}
	s = reportingTestServer(t, path, "https://changed-deployment.example")
	if got := readReportingSettings(t, s); len(got.Endpoints) != 2 || got.DefaultEndpointID != "private" {
		t.Fatal("restart lost address book", got)
	}
	book.DefaultEndpointID = "public"
	if w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", book); w.Code != 200 || readReportingSettings(t, s).EffectiveEndpoint != "https://public.example/base" {
		t.Fatal(w.Code, w.Body)
	}
	// A legacy update remains an explicit replacement, rather than retaining stale choices.
	w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", map[string]string{"endpoint": "https://single.example"})
	if got := readReportingSettings(t, s); w.Code != 200 || len(got.Endpoints) != 1 || got.EffectiveEndpoint != "https://single.example" {
		t.Fatal(got, w.Code)
	}
	w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", reportingAddressBook{Endpoints: []reportingAddress{}})
	if got := readReportingSettings(t, s); w.Code != 200 || got.Endpoint != "" || got.EffectiveEndpoint != "https://changed-deployment.example" || got.DefaultEndpointID != "deployment" {
		t.Fatal(got, w.Code)
	}
}

func TestReportingAddressBookRejectsInvalidAndRollsBack(t *testing.T) {
	s := reportingTestServer(t, filepath.Join(t.TempDir(), "reporting.db"), "https://deployment.example")
	valid := reportingAddressBook{Endpoints: []reportingAddress{{ID: "public", Name: "公网", URL: "https://public.example"}}, DefaultEndpointID: "public"}
	if w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", valid); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	for _, book := range []reportingAddressBook{
		{Endpoints: valid.Endpoints, DefaultEndpointID: "missing"},
		{Endpoints: []reportingAddress{{ID: "same", Name: "一", URL: "https://one.example"}, {ID: "same", Name: "二", URL: "https://two.example"}}, DefaultEndpointID: "same"},
		{Endpoints: []reportingAddress{{ID: "one", Name: "一", URL: "https://same.example"}, {ID: "two", Name: "二", URL: "https://same.example/"}}, DefaultEndpointID: "one"},
		{Endpoints: []reportingAddress{{ID: "one", Name: "", URL: "https://one.example"}}, DefaultEndpointID: "one"},
		{Endpoints: []reportingAddress{{ID: "one", Name: "一", URL: "https://user:secret@one.example"}}, DefaultEndpointID: "one"},
		{Endpoints: []reportingAddress{{ID: "one", Name: "一", URL: "https://one.example?key=secret"}}, DefaultEndpointID: "one"},
	} {
		w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", book)
		if w.Code != 400 || readReportingSettings(t, s).EffectiveEndpoint != "https://public.example" {
			t.Fatal("invalid update changed configuration", w.Code, w.Body)
		}
	}
	if _, err := s.DB.Exec("CREATE TRIGGER reporting_failure BEFORE UPDATE ON instance_settings WHEN NEW.name='reporting_endpoints' BEGIN SELECT RAISE(ABORT,'test failure'); END"); err != nil {
		t.Fatal(err)
	}
	changed := reportingAddressBook{Endpoints: []reportingAddress{{ID: "new", Name: "新地址", URL: "https://new.example"}}, DefaultEndpointID: "new"}
	if w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/reporting", changed); w.Code != 500 {
		t.Fatal(w.Code, w.Body)
	}
	var legacy string
	if err := s.DB.QueryRow("SELECT value FROM instance_settings WHERE name='reporting_endpoint'").Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if legacy != "https://public.example" || readReportingSettings(t, s).EffectiveEndpoint != legacy {
		t.Fatal("partial update committed", legacy)
	}
}
