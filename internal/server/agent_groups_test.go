package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/agent"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
)

func testGroupServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	db, err := storage.Open(filepath.Join(dir, "groups.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	a, err := auth.New(db, dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	ch := storage.NewClickHouse("http://unused.invalid", "fixture", "")
	catalog, err := ingest.NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: db, Auth: a, Catalog: catalog, API: http.NewServeMux(), Public: http.NewServeMux()}
	if err = s.registerCore(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("agent-test-key"))
	if _, err = db.Exec("INSERT INTO ingest_keys(id,name,token_hash,created_at,allow_all_tables) VALUES('agent-key','agent key',?,'2026-10-11',1)", hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	return s
}
func groupRequest(t *testing.T, s *Server, public bool, role, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, _ := json.Marshal(body)
	r := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	r.Header.Set("Authorization", "Bearer agent-test-key")
	r = r.WithContext(shared.WithUser(context.Background(), shared.User{Role: role}))
	w := httptest.NewRecorder()
	if public {
		s.Public.ServeHTTP(w, r)
	} else {
		s.API.ServeHTTP(w, r)
	}
	return w
}
func responseGroup(t *testing.T, w *httptest.ResponseRecorder) agentGroup {
	t.Helper()
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("group request: %d %s", w.Code, w.Body)
	}
	var group agentGroup
	if err := json.Unmarshal(w.Body.Bytes(), &group); err != nil {
		t.Fatal(err)
	}
	return group
}
func remoteTasks(t *testing.T, s *Server, id string) agent.RemoteConfig {
	t.Helper()
	w := groupRequest(t, s, true, "", "GET", "/api/v1/agents/"+id+"/config", nil)
	if w.Code != 200 {
		t.Fatalf("remote tasks: %d %s", w.Code, w.Body)
	}
	var conf agent.RemoteConfig
	if err := json.Unmarshal(w.Body.Bytes(), &conf); err != nil {
		t.Fatal(err)
	}
	return conf
}
func TestAgentGroupsEnrollmentTasksAndPlatformReassignment(t *testing.T) {
	s := testGroupServer(t)
	enabled := true
	disabled := false
	a := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "生产服务器", "config": agent.RemoteConfig{CollectIntervalSeconds: 10, HostEnabled: &enabled, HostCollectors: []string{"memory"}, HostTable: "machines_a", ProbeTable: "checks_a"}}))
	b := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "仅拨测", "config": agent.RemoteConfig{CollectIntervalSeconds: 15, HostEnabled: &disabled, HostCollectors: []string{}, HostTable: "machines_b", ProbeTable: "checks_b"}}))
	for _, id := range []string{"node-a", "node-b"} {
		w := groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": id, "hostname": id, "group_id": a.ID})
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	first, second := remoteTasks(t, s, "node-a"), remoteTasks(t, s, "node-b")
	if first.Revision != second.Revision || first.GroupID != a.ID || first.HostTable != "machines_a" {
		t.Fatal("group members do not share tasks")
	}
	updated := a.Config
	updated.HostCollectors = []string{"network"}
	updated.CollectIntervalSeconds = 5
	a = responseGroup(t, groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/"+a.ID, map[string]any{"name": a.Name, "config": updated}))
	if a.Config.Revision == first.Revision || remoteTasks(t, s, "node-a").Revision != a.Config.Revision || remoteTasks(t, s, "node-b").Revision != a.Config.Revision {
		t.Fatal("group edit did not reach both agents")
	}
	w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/node-a/group", map[string]string{"group_id": b.ID})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if conf := remoteTasks(t, s, "node-a"); conf.GroupID != b.ID || *conf.HostEnabled || conf.ProbeTable != "checks_b" {
		t.Fatal("platform reassignment did not update tasks")
	}
	// Heartbeats and restarts keep the platform choice, even if the local install command is old.
	for _, path := range []string{"/api/v1/agents/register", "/api/v1/agents/node-a/heartbeat"} {
		w = groupRequest(t, s, true, "", "POST", path, map[string]any{"agent_id": "node-a", "hostname": "node-a", "group_id": a.ID})
		if w.Code != 200 || remoteTasks(t, s, "node-a").GroupID != b.ID {
			t.Fatal("old enrollment group overwrote platform reassignment")
		}
	}
	groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/node-b/group", map[string]string{"group_id": "default"})
	w = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-groups/"+a.ID, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	w = groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": "node-a", "group_id": a.ID})
	if w.Code != 200 || remoteTasks(t, s, "node-a").GroupID != b.ID {
		t.Fatal("deleted local enrollment group prevented restart")
	}
	w = groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": "unknown-node", "group_id": "missing"})
	if w.Code != 400 {
		t.Fatal("unknown enrollment group accepted")
	}
	w = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-groups/"+b.ID, nil)
	if w.Code != 409 {
		t.Fatal("nonempty group deleted")
	}
	w = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-groups/default", nil)
	if w.Code != 409 {
		t.Fatal("default group deleted")
	}
	// A new service instance reads the same membership and group task revision.
	restarted := &Server{DB: s.DB}
	if err := restarted.initAgentTasks(); err != nil {
		t.Fatal(err)
	}
	var id string
	s.DB.QueryRow("SELECT group_id FROM agents WHERE id='node-a'").Scan(&id)
	g, err := restarted.agentGroup(id)
	if err != nil || g.ID != b.ID || g.Config.Revision != b.Config.Revision {
		t.Fatal("restart lost group tasks")
	}
}

func TestGroupConfigValidationAndPermissions(t *testing.T) {
	s := testGroupServer(t)
	for _, entry := range []struct {
		method, path string
		body         any
		status       int
	}{
		{"POST", "/api/v1/agent-groups", map[string]string{"name": "member group"}, 403},
		{"PUT", "/api/v1/agent-groups/default", map[string]string{"name": "renamed"}, 403},
		{"PUT", "/api/v1/agents/missing/group", map[string]string{"group_id": "default"}, 403},
		{"DELETE", "/api/v1/agent-groups/default", nil, 403},
	} {
		if w := groupRequest(t, s, false, "member", entry.method, entry.path, entry.body); w.Code != entry.status {
			t.Fatal(w.Code, w.Body)
		}
	}
	invalid := []map[string]any{
		{"collect_interval_seconds": 0}, {"collect_interval_seconds": 86401},
		{"collect_interval_seconds": 15, "host_table": "metric_private"},
		{"collect_interval_seconds": 15, "host_collectors": []string{}},
		{"collect_interval_seconds": 15, "host_collectors": []string{"unknown"}},
		{"collect_interval_seconds": 15, "host_collectors": []string{"process"}},
		{"collect_interval_seconds": 15, "probes": []map[string]any{{"id": "bad", "kind": "http", "target": "file:///tmp/data", "interval_seconds": 60, "timeout_ms": 5000}}},
		{"collect_interval_seconds": 15, "probes": []map[string]any{{"id": "bad", "kind": "tcp", "target": "no-port", "interval_seconds": 60, "timeout_ms": 5000}}},
	}
	before, _ := s.agentGroup("default")
	for _, conf := range invalid {
		w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/default", map[string]any{"name": "默认分组", "config": conf})
		if w.Code != 400 {
			t.Fatalf("invalid config %v: %d %s", conf, w.Code, w.Body)
		}
	}
	after, _ := s.agentGroup("default")
	if after.Config.Revision != before.Config.Revision {
		t.Fatal("invalid save replaced group configuration")
	}
	w := groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]string{"name": "默认分组"})
	if w.Code != 409 {
		t.Fatal("duplicate name accepted")
	}
	w = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/missing", map[string]string{"name": "none"})
	if w.Code != 404 {
		t.Fatal("missing group save accepted")
	}
}

func TestExistingAgentsJoinDefaultGroup(t *testing.T) {
	s := testGroupServer(t)
	if _, err := s.DB.Exec("ALTER TABLE agents DROP COLUMN group_id"); err != nil {
		t.Fatal(err)
	}
	_, err := s.DB.Exec("INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat) VALUES('existing','','existing','','linux','amd64','','{}')")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.initAgentTasks(); err != nil {
		t.Fatal(err)
	}
	var groupID string
	s.DB.QueryRow("SELECT group_id FROM agents WHERE id='existing'").Scan(&groupID)
	if groupID != "default" {
		t.Fatal("existing Agent did not join default group")
	}
	if err = s.initAgentTasks(); err != nil {
		t.Fatal(err)
	}
	groups, err := s.agentGroups()
	if err != nil || len(groups) != 1 || groups[0].AgentCount != 1 {
		t.Fatal("group setup not idempotent")
	}
}
