package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/agent"
)

func TestAgentTaskMigrationPreservesLegacyConfigAndDoesNotResurrect(t *testing.T) {
	s := testGroupServer(t)
	for _, table := range []string{"agent_node_labels", "agent_task_targets", "agent_tasks", "agent_task_labels", "agent_task_migrations"} {
		if _, err := s.DB.Exec("DROP TABLE " + table); err != nil {
			t.Fatal(err)
		}
	}
	old := agent.NormalizeRemoteConfig(agent.RemoteConfig{Revision: "original-revision", CollectIntervalSeconds: 7, HostEnabled: boolPointer(true), HostCollectors: []string{"memory", "process"}, ProcessNames: []string{"worker*"}, HostTable: "machines_old", ProbeTable: "checks_old", Probes: []agent.Probe{modelProbe("old-check", "https://old.example/ready")}, LogsEnabled: boolPointer(true), LogTable: "files_old", LogSources: []agent.LogSource{{Directory: "/var/log/legacy", Pattern: "*.txt", Recursive: true, FromBeginning: true}}})
	raw, _ := json.Marshal(old)
	name := strings.Repeat("长", 40)
	if _, err := s.DB.Exec(`INSERT INTO agent_groups(id,name,config,created_at) VALUES('old',?,?,'2026-10-10')`, name, string(raw)); err != nil {
		t.Fatal(err)
	}
	heartbeat := `{"config_revision":"original-revision","queue_batches":14}`
	if _, err := s.DB.Exec(`INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES('legacy-node','stable-host','legacy','0.1.0','linux','amd64','2026-10-10',?,'old')`, heartbeat); err != nil {
		t.Fatal(err)
	}
	if err := s.initAgentTasks(); err != nil {
		t.Fatal(err)
	}
	labels, err := readAgentTaskLabels(s.DB)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, l := range labels {
		if l.ID == "old" {
			found = true
			if l.Name != name || l.NodeCount != 1 || l.TaskCount != 3 {
				t.Fatal("migration changed legacy label", l)
			}
		}
		if l.ID == "default" && l.Name != "默认标签" {
			t.Fatal("default label display name not migrated", l)
		}
	}
	if !found {
		t.Fatal("legacy label missing")
	}
	compiled := remoteTasks(t, s, "legacy-node")
	if compiled.HostTable != old.HostTable || compiled.ProbeTable != old.ProbeTable || compiled.LogTable != old.LogTable || compiled.CollectIntervalSeconds != 7 || len(compiled.ProcessNames) != 1 || compiled.ProcessNames[0] != "worker*" || len(compiled.Probes) != 1 || len(compiled.LogSources) != 1 || !compiled.LogSources[0].FromBeginning || !compiled.LogSources[0].Recursive {
		t.Fatalf("migration lost original task parameters: %#v", compiled)
	}
	tasks, err := readAgentTasks(s.DB)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range tasks {
		if len(task.Name) > 128 {
			t.Fatal("long legacy name not safely adapted")
		}
	}
	var host, storedHeartbeat string
	if err = s.DB.QueryRow(`SELECT host_id,heartbeat FROM agents WHERE id='legacy-node'`).Scan(&host, &storedHeartbeat); err != nil || host != "stable-host" || storedHeartbeat != heartbeat {
		t.Fatal("migration changed node data", host, storedHeartbeat, err)
	}
	// Removing a migrated task and all node labels must survive repeated startup.
	response := groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-tasks/legacy:old:log", nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	setTaskLabels(t, s, "legacy-node")
	for i := 0; i < 2; i++ {
		if err = s.initAgentTasks(); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err = s.DB.QueryRow(`SELECT count(*) FROM agent_tasks WHERE id='legacy:old:log'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("restart resurrected removed migrated task", count, err)
	}
	ids, err := nodeAgentLabelIDs(s.DB, "legacy-node")
	if err != nil || len(ids) != 0 {
		t.Fatal("restart restored deliberately empty assignment", ids, err)
	}
	if got := remoteTasks(t, s, "legacy-node"); *got.HostEnabled || *got.LogsEnabled || len(got.Probes) != 0 {
		t.Fatal("restart restored withdrawn task", got)
	}
}
func TestAgentTaskMigrationPreservesCustomDefaultName(t *testing.T) {
	s := testGroupServer(t)
	for _, table := range []string{"agent_node_labels", "agent_task_targets", "agent_tasks", "agent_task_labels", "agent_task_migrations"} {
		if _, err := s.DB.Exec("DROP TABLE " + table); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.Exec(`UPDATE agent_groups SET name='我的生产节点' WHERE id='default'`); err != nil {
		t.Fatal(err)
	}
	if err := s.initAgentTasks(); err != nil {
		t.Fatal(err)
	}
	labels, err := readAgentTaskLabels(s.DB)
	if err != nil || len(labels) != 1 || labels[0].Name != "我的生产节点" {
		t.Fatal("custom default name overwritten", labels, err)
	}
}
func TestAgentLegacyWritesDoNotCloneOrDeleteIndependentTasks(t *testing.T) {
	s := testGroupServer(t)
	group := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "legacy", "config": agent.RemoteConfig{CollectIntervalSeconds: 15, HostCollectors: []string{"memory"}, HostTable: "machines"}}))
	registerTaskNode(t, s, "node", group.ID)
	probe := createIndependentTask(t, s, "extra-probe", "probe", []string{group.ID}, agent.RemoteConfig{Probes: []agent.Probe{modelProbe("extra", "https://extra.example")}})
	// A combined legacy GET includes the independent task, but PUT must never clone it.
	mixed, _ := s.agentGroup(group.ID)
	response := groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/"+group.ID, map[string]any{"name": "legacy", "config": mixed.Config})
	if response.Code != 409 {
		t.Fatal("old full-bundle save accepted independent work", response.Code, response.Body)
	}
	// Renaming the label is safe and must not rewrite tasks from a combined config.
	group = responseGroup(t, groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/"+group.ID, map[string]any{"name": "renamed"}))
	compiled := remoteTasks(t, s, "node")
	if len(compiled.HostCollectors) != 1 || compiled.HostCollectors[0] != "memory" || len(compiled.Probes) != 1 {
		t.Fatal("label rename lost independent task", compiled)
	}
	setTaskLabels(t, s, "node")
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-groups/"+group.ID, nil)
	if response.Code != 409 {
		t.Fatal("legacy delete removed independently managed task", response.Code, response.Body)
	}
	setTaskLabels(t, s, "node", group.ID)
	response = groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-tasks/"+probe.ID, nil)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body)
	}
	if got := remoteTasks(t, s, "node"); len(got.Probes) != 0 {
		t.Fatal("independent task was cloned by legacy rename and still executes", got)
	}
}
func TestAgentLegacyWriteAndDeleteRefuseRetargetedMigrationTask(t *testing.T) {
	s := testGroupServer(t)
	a := responseGroup(t, groupRequest(t, s, false, "admin", "POST", "/api/v1/agent-groups", map[string]any{"name": "A"}))
	b := createTaskLabel(t, s, "B")
	tasks, err := readAgentTasks(s.DB)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range tasks {
		if task.ID == "legacy:"+a.ID+":host" {
			task.LabelIDs = []string{b.ID}
			updateIndependentTask(t, s, task, 200)
		}
	}
	registerTaskNode(t, s, "node", b.ID)
	before := remoteTasks(t, s, "node")
	response := groupRequest(t, s, false, "admin", "DELETE", "/api/v1/agent-groups/"+a.ID, nil)
	if response.Code != 409 {
		t.Fatal("legacy delete removed a task retargeted to another label", response.Code, response.Body)
	}
	response = groupRequest(t, s, false, "admin", "PUT", "/api/v1/agent-groups/"+a.ID, map[string]any{"name": "A", "config": a.Config})
	if response.Code != 409 {
		t.Fatal("legacy save overwrote retargeted task", response.Code, response.Body)
	}
	if got := remoteTasks(t, s, "node"); got.Revision != before.Revision || !*got.HostEnabled {
		t.Fatal("retargeted task changed", got)
	}
}
