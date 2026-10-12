package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

func TestSDKReportingAPIAuthScopesPersistenceAndValidation(t *testing.T) {
	s := testGroupServer(t)
	for _, table := range []struct{ id, logical, kind string }{{"log_app", "app", "log"}, {"log_secret", "secret", "log"}, {"log_lightmoni_sdk", "lightmoni_sdk", "log"}, {"metric_app_sum", "app", "metric"}} {
		if _, err := s.DB.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json) VALUES(?,?,?,?,'','[]')", table.id, table.id, table.logical, table.kind); err != nil {
			t.Fatal(err)
		}
	}
	full := moni.DefaultLogSampling()
	for _, id := range []string{"log_app", "log_secret"} {
		w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/catalog/tables/"+id+"/log-sampling", full)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	for _, test := range []struct {
		role, path string
		body       any
		status     int
	}{{"member", "log_app", full, 403}, {"admin", "log_lightmoni_sdk", full, 400}, {"admin", "metric_app_sum", full, 400}, {"admin", "missing", full, 404}, {"admin", "log_app", map[string]any{}, 400}, {"admin", "log_app", map[string]any{"rules": []any{}}, 200}} {
		w := groupRequest(t, s, false, test.role, "PUT", "/api/v1/catalog/tables/"+test.path+"/log-sampling", test.body)
		if w.Code != test.status {
			t.Fatal(test, w.Code, w.Body)
		}
	}
	w := groupRequest(t, s, false, "member", "GET", "/api/v1/catalog/tables/log_app/log-sampling", nil)
	var policy moni.LogSamplingPolicy
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &policy) != nil || len(policy.Rules) != 0 {
		t.Fatal("saved empty whitelist not read back", w.Body)
	}
	if _, err := s.DB.Exec(`UPDATE ingest_keys SET allow_all_tables=0,allowed_tables_json='["app"]' WHERE id='agent-key'`); err != nil {
		t.Fatal(err)
	}
	get := func() moni.SDKConfig {
		w := groupRequest(t, s, true, "", "GET", "/v1/sdk-config", nil)
		var c moni.SDKConfig
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &c) != nil {
			t.Fatal(w.Code, w.Body)
		}
		return c
	}
	first := get()
	if len(first.LogSampling) != 1 || first.LogSampling["app"].Rules == nil || first.Revision == "" {
		t.Fatal("scope leak", first)
	}
	disable := map[string]any{"disable_rules": []moni.LogExcludeRule{{Name: "stop", Conditions: []moni.LogCondition{{Field: "service", Operator: "in", Values: []any{"one"}}}}}}
	if w = groupRequest(t, s, false, "member", "PUT", "/api/v1/settings/sdk-reporting", disable); w.Code != 403 {
		t.Fatal("member changed reporting")
	}
	if w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/sdk-reporting", disable); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	second := get()
	if first.Revision == second.Revision || len(second.DisableRules) != 1 {
		t.Fatal("no dynamic revision")
	}
	if w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/settings/sdk-reporting", map[string]any{"disable_rules": []moni.LogExcludeRule{{Name: "bad", Conditions: []moni.LogCondition{{Field: "attr:user_id", Operator: "exists"}}}}}); w.Code != 400 {
		t.Fatal("SDK was allowed to select per-log UID")
	}
	req := httptest.NewRequest(http.MethodGet, "/v1/sdk-config", nil)
	response := httptest.NewRecorder()
	s.Public.ServeHTTP(response, req)
	if response.Code != 401 {
		t.Fatal("unauthenticated config read")
	}
}
