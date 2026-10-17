package server

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lightmoni/lightmoni/internal/agent"
)

func createTaskLabel(t *testing.T, s *Server, name string) agentTaskLabel {
	t.Helper()
	w := groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-task-labels", map[string]any{"name": name})
	if w.Code != 201 {
		t.Fatalf("create label: %d %s", w.Code, w.Body)
	}
	var l agentTaskLabel
	if err := json.Unmarshal(w.Body.Bytes(), &l); err != nil {
		t.Fatal(err)
	}
	return l
}
func createIndependentTask(t *testing.T, s *Server, name, kind string, ids []string, c agent.RemoteConfig) agentTask {
	t.Helper()
	w := groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-tasks", agentTask{Name: name, Type: kind, Enabled: true, LabelIDs: ids, Config: c})
	if w.Code != 201 {
		t.Fatalf("create task: %d %s", w.Code, w.Body)
	}
	var task agentTask
	if err := json.Unmarshal(w.Body.Bytes(), &task); err != nil {
		t.Fatal(err)
	}
	return task
}
func registerTaskNode(t *testing.T, s *Server, id, label string) {
	t.Helper()
	w := groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": id, "hostname": id, "host_id": "identity-" + id, "group_id": label})
	if w.Code != 200 {
		t.Fatalf("register: %d %s", w.Code, w.Body)
	}
}
func setTaskLabels(t *testing.T, s *Server, node string, ids ...string) {
	t.Helper()
	if ids == nil {
		ids = []string{}
	}
	w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/"+node+"/labels", map[string]any{"label_ids": ids})
	if w.Code != 200 {
		t.Fatalf("labels: %d %s", w.Code, w.Body)
	}
}
func updateIndependentTask(t *testing.T, s *Server, task agentTask, status int) {
	t.Helper()
	w := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-tasks/"+task.ID, task)
	if w.Code != status {
		t.Fatalf("task update: got %d want %d: %s", w.Code, status, w.Body)
	}
}
func modelProbe(id, target string) agent.Probe {
	return agent.Probe{ID: id, Kind: "http", Target: target, IntervalSeconds: 60, TimeoutMS: 1000, ExpectedStatus: []int{200}}
}

func TestAgentTasksMultiLabelMatchingWithdrawalAndLegacyHeartbeat(t *testing.T) {
	s := testGroupServer(t)
	a := createTaskLabel(t, s, "production")
	b := createTaskLabel(t, s, "orders")
	host := createIndependentTask(t, s, "主机指标", "host", []string{a.ID}, agent.RemoteConfig{CollectIntervalSeconds: 10, HostCollectors: []string{"memory"}, HostTable: "machines"})
	probe := createIndependentTask(t, s, "订单拨测", "probe", []string{a.ID, b.ID}, agent.RemoteConfig{ProbeTable: "checks", Probes: []agent.Probe{modelProbe("orders", "https://orders.example/health")}})
	log := createIndependentTask(t, s, "订单日志", "log", []string{b.ID}, agent.RemoteConfig{LogTable: "order_logs", LogSources: []agent.LogSource{{Directory: "/var/log/orders", Pattern: "*.log*"}}})
	registerTaskNode(t, s, "node-a", a.ID)
	registerTaskNode(t, s, "node-b", b.ID)
	ca := remoteTasks(t, s, "node-a")
	cb := remoteTasks(t, s, "node-b")
	if !*ca.HostEnabled || *ca.LogsEnabled || len(ca.Probes) != 1 || ca.HostTable != "machines" || ca.CollectIntervalSeconds != 10 {
		t.Fatalf("wrong initial host config: %#v", ca)
	}
	if *cb.HostEnabled || !*cb.LogsEnabled || cb.LogTable != "order_logs" {
		t.Fatalf("unmatched host task leaked: %#v", cb)
	}
	setTaskLabels(t, s, "node-a", b.ID, a.ID, a.ID)
	combined := remoteTasks(t, s, "node-a")
	if !*combined.HostEnabled || !*combined.LogsEnabled || len(combined.Probes) != 1 || len(combined.LogSources) != 1 {
		t.Fatalf("multi-label failed/double counted: %#v", combined)
	}
	if combined.Revision == ca.Revision {
		t.Fatal("assignment failed to change revision")
	}
	nodes, err := s.listExecutionNodes()
	if err != nil {
		t.Fatal(err)
	}
	for _, node := range nodes {
		if node["id"] == "node-a" {
			if len(node["label_ids"].([]string)) != 2 || len(node["task_ids"].([]string)) != 3 || len(node["labels"].([]nodeTaskLabel)) != 2 || len(node["tasks"].([]nodeTaskSummary)) != 3 {
				t.Fatalf("bad metadata: %#v", node)
			}
		}
	}
	// A stale install label cannot reassign an existing node, including after it has no labels.
	registerTaskNode(t, s, "node-a", "deleted-old-label")
	if got := remoteTasks(t, s, "node-a"); got.Revision != combined.Revision {
		t.Fatal("old local group changed center assignment")
	}
	log.Enabled = false
	updateIndependentTask(t, s, log, 200)
	if got := remoteTasks(t, s, "node-a"); *got.LogsEnabled || len(got.LogSources) != 0 || !*got.HostEnabled {
		t.Fatal("disabled log task remains", got)
	}
	setTaskLabels(t, s, "node-a")
	none := remoteTasks(t, s, "node-a")
	if *none.HostEnabled || *none.LogsEnabled || len(none.Probes) > 0 || len(none.HostCollectors) > 0 {
		t.Fatal("empty labels did not withdraw tasks", none)
	}
	registerTaskNode(t, s, "node-a", a.ID)
	if got := remoteTasks(t, s, "node-a"); got.Revision != none.Revision {
		t.Fatal("heartbeat restored removed labels")
	}
	// Empty task targets never imply all nodes.
	host.LabelIDs = []string{}
	updateIndependentTask(t, s, host, 200)
	probe.LabelIDs = []string{}
	updateIndependentTask(t, s, probe, 200)
	if got := remoteTasks(t, s, "node-b"); len(got.Probes) != 0 || *got.HostEnabled || *got.LogsEnabled {
		t.Fatal("empty targets broadcast", got)
	}
}
func TestAgentTaskConflictsAreAtomicAndPointToNodesAndTasks(t *testing.T) {
	s := testGroupServer(t)
	a := createTaskLabel(t, s, "first")
	b := createTaskLabel(t, s, "second")
	first := createIndependentTask(t, s, "内存", "host", []string{a.ID}, agent.RemoteConfig{CollectIntervalSeconds: 10, HostTable: "host_a", HostCollectors: []string{"memory"}})
	second := createIndependentTask(t, s, "CPU", "host", []string{b.ID}, agent.RemoteConfig{CollectIntervalSeconds: 20, HostTable: "host_b", HostCollectors: []string{"cpu"}})
	registerTaskNode(t, s, "node", a.ID)
	before := remoteTasks(t, s, "node")
	response := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/node/labels", map[string]any{"label_ids": []string{a.ID, b.ID}})
	if response.Code != 409 || !strings.Contains(response.Body.String(), "内存") || !strings.Contains(response.Body.String(), "CPU") {
		t.Fatal("missing conflict context", response.Code, response.Body)
	}
	if after := remoteTasks(t, s, "node"); after.Revision != before.Revision {
		t.Fatal("failed label update mutated config")
	}
	ids, err := nodeAgentLabelIDs(s.DB, "node")
	if err != nil || len(ids) != 1 || ids[0] != a.ID {
		t.Fatal("failed update changed labels", ids, err)
	}
	second.LabelIDs = []string{a.ID}
	updateIndependentTask(t, s, second, 409)
	if after := remoteTasks(t, s, "node"); after.Revision != before.Revision {
		t.Fatal("failed task update mutated config")
	}
	stored, err := readAgentTasks(s.DB)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range stored {
		if task.ID == second.ID && (len(task.LabelIDs) != 1 || task.LabelIDs[0] != b.ID) {
			t.Fatal("failed update changed targets")
		}
	}
	second.Config.CollectIntervalSeconds = 10
	second.Config.HostTable = "host_a"
	second.LabelIDs = []string{a.ID, b.ID}
	updateIndependentTask(t, s, second, 200)
	setTaskLabels(t, s, "node", a.ID, b.ID)
	both := remoteTasks(t, s, "node")
	if len(both.HostCollectors) != 2 || both.HostCollectors[0] != "cpu" || both.HostCollectors[1] != "memory" {
		t.Fatal("compatible host tasks not merged", both)
	}
	first.Config.CollectIntervalSeconds = 30
	response = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-tasks/"+first.ID, first)
	if response.Code != 409 || !strings.Contains(response.Body.String(), "node") {
		t.Fatal("conflict did not identify node", response.Code, response.Body)
	}
	if remoteTasks(t, s, "node").Revision != both.Revision {
		t.Fatal("conflict replaced last valid config")
	}
}
func TestAgentTaskProbeAndLogMergingConflictsAndBounds(t *testing.T) {
	for _, kind := range []string{"probe", "log"} {
		t.Run(kind, func(t *testing.T) {
			s := testGroupServer(t)
			a := createTaskLabel(t, s, "A")
			b := createTaskLabel(t, s, "B")
			c := agent.RemoteConfig{ProbeTable: "checks", Probes: []agent.Probe{modelProbe("main", "https://service.example")}, LogTable: "files", LogSources: []agent.LogSource{{Directory: "/var/log/orders", Pattern: "*.log", FromBeginning: false}}}
			createIndependentTask(t, s, "first", kind, []string{a.ID}, c)
			second := createIndependentTask(t, s, "second", kind, []string{b.ID}, c)
			registerTaskNode(t, s, "node", a.ID)
			setTaskLabels(t, s, "node", a.ID, b.ID)
			got := remoteTasks(t, s, "node")
			if kind == "probe" && len(got.Probes) != 1 || kind == "log" && len(got.LogSources) != 1 {
				t.Fatal("duplicate source executed twice", got)
			}
			if kind == "probe" {
				second.Config.Probes[0].Target = "https://different.example"
			} else {
				second.Config.LogSources[0].FromBeginning = true
			}
			updateIndependentTask(t, s, second, 409)
			if remoteTasks(t, s, "node").Revision != got.Revision {
				t.Fatal("failed conflicting save mutated revision")
			}
			// Different output tables also cannot be silently selected.
			if kind == "probe" {
				second.Config.Probes[0].Target = "https://service.example"
				second.Config.ProbeTable = "other_checks"
			} else {
				second.Config.LogSources[0].FromBeginning = false
				second.Config.LogTable = "other_logs"
			}
			updateIndependentTask(t, s, second, 409)
		})
	}
	t.Run("combined-log-limit", func(t *testing.T) {
		s := testGroupServer(t)
		a := createTaskLabel(t, s, "A")
		b := createTaskLabel(t, s, "B")
		sources := func(prefix string) []agent.LogSource {
			result := []agent.LogSource{}
			for i := 0; i < 17; i++ {
				result = append(result, agent.LogSource{Directory: fmt.Sprintf("/logs/%s/%d", prefix, i), Pattern: "*.log"})
			}
			return result
		}
		createIndependentTask(t, s, "logs-a", "log", []string{a.ID}, agent.RemoteConfig{LogSources: sources("a")})
		createIndependentTask(t, s, "logs-b", "log", []string{b.ID}, agent.RemoteConfig{LogSources: sources("b")})
		registerTaskNode(t, s, "node", a.ID)
		response := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/node/labels", map[string]any{"label_ids": []string{a.ID, b.ID}})
		if response.Code != 409 {
			t.Fatal("combined bound bypassed", response.Code, response.Body)
		}
	})
}
func TestAgentTaskLabelsLifecyclePermissionsAndRevision(t *testing.T) {
	s := testGroupServer(t)
	label := createTaskLabel(t, s, "边缘节点")
	task := createIndependentTask(t, s, "memory", "host", []string{label.ID}, agent.RemoteConfig{CollectIntervalSeconds: 15, HostCollectors: []string{"memory"}})
	registerTaskNode(t, s, "node", label.ID)
	before := remoteTasks(t, s, "node")
	for _, entry := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/agent-task-labels", map[string]any{"name": "bad"}}, {"PUT", "/api/v1/agent-task-labels/" + label.ID, map[string]any{"name": "bad"}}, {"DELETE", "/api/v1/agent-task-labels/" + label.ID, nil},
		{"POST", "/api/v1/agent-tasks", task}, {"PUT", "/api/v1/agent-tasks/" + task.ID, task}, {"DELETE", "/api/v1/agent-tasks/" + task.ID, nil}, {"PUT", "/api/v1/agents/node/labels", map[string]any{"label_ids": []string{}}},
	} {
		if response := groupRequest(t, s, false, "member", entry.method, entry.path, entry.body); response.Code != 403 {
			t.Fatalf("member write: %d %s", response.Code, response.Body)
		}
	}
	for _, path := range []string{"/api/v1/agent-task-labels", "/api/v1/agent-tasks", "/api/v1/agents"} {
		if response := groupRequest(t, s, false, "member", "GET", path, nil); response.Code != 200 {
			t.Fatal("member read", response.Code, response.Body)
		}
	}
	response := groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-task-labels/"+label.ID, nil)
	if response.Code != 409 {
		t.Fatal("referenced label deleted")
	}
	response = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-task-labels/"+label.ID, map[string]any{"name": " 重命名 "})
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	renamed := remoteTasks(t, s, "node")
	if renamed.Revision == before.Revision {
		t.Fatal("metadata rename failed to invalidate revision")
	}
	if again := remoteTasks(t, s, "node"); again.Revision != renamed.Revision {
		t.Fatal("unchanged compile is nondeterministic")
	}
	response = groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-task-labels", map[string]any{"name": "重命名"})
	if response.Code != 409 {
		t.Fatal("duplicate label accepted")
	}
	setTaskLabels(t, s, "node")
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-task-labels/"+label.ID, nil)
	if response.Code != 409 {
		t.Fatal("task reference ignored")
	}
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-tasks/"+task.ID, nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-task-labels/"+label.ID, nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-task-labels/default", nil)
	if response.Code != 409 {
		t.Fatal("default label removed")
	}
	// New registration rejects unknown labels; existing center assignment ignores them.
	response = groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": "new-node", "group_id": "missing"})
	if response.Code != 400 {
		t.Fatal("unknown initial label accepted", response.Code, response.Body)
	}
	response = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/node/labels", map[string]any{})
	if response.Code != 400 {
		t.Fatal("missing label list silently withdrew tasks")
	}
	response = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agents/missing/labels", map[string]any{"label_ids": []string{}})
	if response.Code != 404 {
		t.Fatal("missing node labels accepted")
	}
	// Real auth middleware protects the newly introduced read endpoints.
	response = httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/api/v1/agent-task-labels", nil))
	if response.Code != 401 {
		t.Fatal("unauthenticated read", response.Code)
	}
}
func TestAgentTaskConcurrentConflictingWritesKeepOneValidConfig(t *testing.T) {
	s := testGroupServer(t)
	a := createTaskLabel(t, s, "A")
	b := createTaskLabel(t, s, "B")
	first := createIndependentTask(t, s, "A-host", "host", []string{a.ID}, agent.RemoteConfig{CollectIntervalSeconds: 10, HostCollectors: []string{"memory"}})
	second := createIndependentTask(t, s, "B-host", "host", []string{b.ID}, agent.RemoteConfig{CollectIntervalSeconds: 10, HostCollectors: []string{"cpu"}})
	registerTaskNode(t, s, "node", a.ID)
	setTaskLabels(t, s, "node", a.ID, b.ID)
	first.Config.CollectIntervalSeconds = 20
	second.Config.CollectIntervalSeconds = 20
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, task := range []agentTask{first, second} {
		wg.Add(1)
		go func(task agentTask) {
			defer wg.Done()
			codes <- groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-tasks/"+task.ID, task).Code
		}(task)
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 409 {
			t.Fatal("concurrent incompatible write committed", code)
		}
	}
	if got := remoteTasks(t, s, "node"); got.CollectIntervalSeconds != 10 {
		t.Fatal("atomic conflict lost valid config")
	}
}

func TestAgentTaskInitialRegistrationConflictIs409WithoutAssignment(t *testing.T) {
	s := testGroupServer(t)
	label := createTaskLabel(t, s, "conflicting")
	createIndependentTask(t, s, "fast", "host", []string{label.ID}, agent.RemoteConfig{CollectIntervalSeconds: 10, HostCollectors: []string{"memory"}})
	createIndependentTask(t, s, "slow", "host", []string{label.ID}, agent.RemoteConfig{CollectIntervalSeconds: 20, HostCollectors: []string{"cpu"}})
	response := groupRequest(t, s, true, "", "POST", "/api/v1/agents/register", map[string]any{"agent_id": "new-conflicted", "hostname": "new-conflicted", "group_id": label.ID})
	if response.Code != 409 {
		t.Fatal("registration conflict should be 409", response.Code, response.Body)
	}
	var count int
	if err := s.DB.QueryRow(`SELECT count(*) FROM agents WHERE id='new-conflicted'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed registration left node assignment", count, err)
	}
}
