package server

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/lightmoni/lightmoni/internal/agent"
)

type agentQueryer interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}
type agentTaskLabel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	NodeCount int    `json:"node_count"`
	TaskCount int    `json:"task_count"`
}
type agentTask struct {
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	Type     string             `json:"type"`
	Enabled  bool               `json:"enabled"`
	LabelIDs []string           `json:"label_ids"`
	Config   agent.RemoteConfig `json:"config"`
}
type nodeTaskLabel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type nodeTaskSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}
type compiledAgentTasks struct {
	Config   agent.RemoteConfig
	Labels   []nodeTaskLabel
	Tasks    []nodeTaskSummary
	LabelIDs []string
	TaskIDs  []string
}
type agentConfigError struct {
	Status  int
	Message string
}

func (e *agentConfigError) Error() string { return e.Message }
func agentProblem(status int, format string, args ...any) error {
	return &agentConfigError{status, fmt.Sprintf(format, args...)}
}
func agentErrorStatus(err error) int {
	var p *agentConfigError
	if errors.As(err, &p) {
		return p.Status
	}
	if errors.Is(err, sql.ErrNoRows) {
		return 404
	}
	return 500
}
func boolPointer(v bool) *bool { return &v }
func sortedUnique(values []string) []string {
	m := map[string]bool{}
	for _, v := range values {
		m[v] = true
	}
	result := make([]string, 0, len(m))
	for v := range m {
		result = append(result, v)
	}
	sort.Strings(result)
	return result
}
func validTaskName(name string) bool {
	return strings.TrimSpace(name) != "" && len(strings.TrimSpace(name)) <= 128
}

func (s *Server) initIndependentAgentTasks() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range []string{
		`CREATE TABLE IF NOT EXISTS agent_task_migrations(version TEXT PRIMARY KEY,completed_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS agent_task_labels(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS agent_tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL,created_at TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS agent_task_targets(task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(task_id,label_id))`,
		`CREATE TABLE IF NOT EXISTS agent_node_labels(agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,label_id TEXT NOT NULL REFERENCES agent_task_labels(id),PRIMARY KEY(agent_id,label_id))`,
		`CREATE INDEX IF NOT EXISTS agent_task_targets_label ON agent_task_targets(label_id)`,
		`CREATE INDEX IF NOT EXISTS agent_node_labels_label ON agent_node_labels(label_id)`,
	} {
		if _, err = tx.Exec(stmt); err != nil {
			return err
		}
	}
	var migrated int
	if err = tx.QueryRow(`SELECT count(*) FROM agent_task_migrations WHERE version='independent-tasks-v1'`).Scan(&migrated); err != nil {
		return err
	}
	if migrated == 0 {
		rows, e := tx.Query(`SELECT id,name,config,created_at FROM agent_groups ORDER BY id`)
		if e != nil {
			return e
		}
		type oldGroup struct{ id, name, raw, created string }
		groups := []oldGroup{}
		for rows.Next() {
			var g oldGroup
			if e = rows.Scan(&g.id, &g.name, &g.raw, &g.created); e != nil {
				rows.Close()
				return e
			}
			groups = append(groups, g)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, g := range groups {
			var c agent.RemoteConfig
			if e = json.Unmarshal([]byte(g.raw), &c); e != nil {
				return e
			}
			c = agent.NormalizeRemoteConfig(c)
			name := g.name
			if g.id == defaultAgentGroup && name == "默认分组" {
				name = "默认标签"
			}
			// Preserve user labels even when another old group already owns the new display name.
			var duplicate int
			if e = tx.QueryRow(`SELECT count(*) FROM agent_groups WHERE id<>? AND name=?`, g.id, name).Scan(&duplicate); e != nil {
				return e
			}
			if duplicate > 0 {
				name = g.name
			}
			if _, e = tx.Exec(`INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)`, g.id, name, g.created); e != nil {
				return e
			}
			if e = writeLegacyAgentTasks(tx, g.id, name, c); e != nil {
				return e
			}
		}
		if _, err = tx.Exec(`INSERT INTO agent_node_labels(agent_id,label_id) SELECT id,group_id FROM agents`); err != nil {
			return err
		}
		if _, err = tx.Exec(`INSERT INTO agent_task_migrations(version,completed_at) VALUES('independent-tasks-v1',?)`, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func legacyTaskName(name, suffix string) string {
	for len(name)+len(suffix) > 128 {
		_, size := utf8.DecodeLastRuneInString(name)
		if size == 0 {
			break
		}
		name = name[:len(name)-size]
	}
	return name + suffix
}

// Legacy endpoints retain three predictable task identities; updates affect real tasks.
func writeLegacyAgentTasks(q agentQueryer, labelID, name string, c agent.RemoteConfig) error {
	c = agent.NormalizeRemoteConfig(c)
	for _, kind := range []string{"host", "probe", "log"} {
		enabled := false
		switch kind {
		case "host":
			enabled = *c.HostEnabled
		case "probe":
			enabled = len(c.Probes) > 0
		case "log":
			enabled = *c.LogsEnabled
		}
		task := agentTask{ID: "legacy:" + labelID + ":" + kind, Name: legacyTaskName(name, map[string]string{"host": " · 指标采集", "probe": " · 服务拨测", "log": " · 目录日志"}[kind]), Type: kind, Enabled: enabled, LabelIDs: []string{labelID}, Config: c}
		if err := normalizeAgentTask(&task); err != nil {
			return err
		}
		if err := saveAgentTask(q, task); err != nil {
			return err
		}
	}
	return nil
}
func normalizeAgentTask(t *agentTask) error {
	t.Name = strings.TrimSpace(t.Name)
	if !validTaskName(t.Name) {
		return agentProblem(400, "请填写任务名称，最长 128 字节")
	}
	if len(t.LabelIDs) > 64 {
		return agentProblem(400, "每个任务最多关联 64 个任务标签")
	}
	t.LabelIDs = sortedUnique(t.LabelIDs)
	for _, id := range t.LabelIDs {
		if strings.TrimSpace(id) == "" || len(id) > 64 {
			return agentProblem(400, "任务标签无效")
		}
	}
	source := agent.NormalizeRemoteConfig(t.Config)
	// Copy only the selected type. Defaults from unrelated types must never become work.
	c := agent.NormalizeRemoteConfig(agent.RemoteConfig{Revision: "validate", CollectIntervalSeconds: 15, HostEnabled: boolPointer(false), HostCollectors: []string{}, LogsEnabled: boolPointer(false)})
	switch t.Type {
	case "host":
		c.CollectIntervalSeconds = source.CollectIntervalSeconds
		c.HostTable = source.HostTable
		c.HostCollectors = source.HostCollectors
		c.ProcessNames = source.ProcessNames
		c.HostEnabled = boolPointer(true)
	case "probe":
		c.ProbeTable = source.ProbeTable
		c.Probes = source.Probes
	case "log":
		c.LogTable = source.LogTable
		c.LogSources = source.LogSources
		c.LogsEnabled = boolPointer(true)
	default:
		return agentProblem(400, "任务类型必须是 host、probe 或 log")
	}
	// Empty/disabled legacy log tasks still preserve their settings without requiring a source.
	if t.Type == "log" && len(c.LogSources) == 0 && !t.Enabled {
		c.LogsEnabled = boolPointer(false)
	}
	if t.Type == "host" && len(c.HostCollectors) == 0 && !t.Enabled {
		c.HostEnabled = boolPointer(false)
	}
	if err := agent.ValidateRemoteConfig(c); err != nil {
		return agentProblem(400, "任务配置无效：%s", err)
	}
	c.Revision = ""
	c.GroupID = ""
	t.Config = c
	return nil
}
func saveAgentTask(q agentQueryer, t agentTask) error {
	raw, err := json.Marshal(t.Config)
	if err != nil {
		return err
	}
	_, err = q.Exec(`INSERT INTO agent_tasks(id,name,type,enabled,config,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,enabled=excluded.enabled,config=excluded.config`, t.ID, t.Name, t.Type, t.Enabled, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	if _, err = q.Exec(`DELETE FROM agent_task_targets WHERE task_id=?`, t.ID); err != nil {
		return err
	}
	for _, id := range t.LabelIDs {
		var exists int
		if err = q.QueryRow(`SELECT count(*) FROM agent_task_labels WHERE id=?`, id).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return agentProblem(404, "任务标签不存在：%s", id)
		}
		if _, err = q.Exec(`INSERT INTO agent_task_targets(task_id,label_id) VALUES(?,?)`, t.ID, id); err != nil {
			return err
		}
	}
	return nil
}
func readAgentTasks(q agentQueryer) ([]agentTask, error) {
	rows, err := q.Query(`SELECT id,name,type,enabled,config FROM agent_tasks ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	tasks := []agentTask{}
	for rows.Next() {
		var t agentTask
		var raw string
		if err = rows.Scan(&t.ID, &t.Name, &t.Type, &t.Enabled, &raw); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &t.Config); err != nil {
			rows.Close()
			return nil, err
		}
		t.LabelIDs = []string{}
		tasks = append(tasks, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	byID := map[string]int{}
	for i, t := range tasks {
		byID[t.ID] = i
	}
	rows, err = q.Query(`SELECT task_id,label_id FROM agent_task_targets ORDER BY label_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var taskID, labelID string
		if err = rows.Scan(&taskID, &labelID); err != nil {
			return nil, err
		}
		if i, ok := byID[taskID]; ok {
			tasks[i].LabelIDs = append(tasks[i].LabelIDs, labelID)
		}
	}
	return tasks, rows.Err()
}
func readAgentTaskLabels(q agentQueryer) ([]agentTaskLabel, error) {
	rows, err := q.Query(`SELECT l.id,l.name,(SELECT count(*) FROM agent_node_labels WHERE label_id=l.id),(SELECT count(*) FROM agent_task_targets WHERE label_id=l.id) FROM agent_task_labels l ORDER BY CASE WHEN l.id='default' THEN 0 ELSE 1 END,l.created_at,l.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	labels := []agentTaskLabel{}
	for rows.Next() {
		var l agentTaskLabel
		if err = rows.Scan(&l.ID, &l.Name, &l.NodeCount, &l.TaskCount); err != nil {
			return nil, err
		}
		labels = append(labels, l)
	}
	return labels, rows.Err()
}
func nodeAgentLabelIDs(q agentQueryer, id string) ([]string, error) {
	rows, err := q.Query(`SELECT label_id FROM agent_node_labels WHERE agent_id=? ORDER BY label_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			return nil, err
		}
		ids = append(ids, value)
	}
	return ids, rows.Err()
}
func compileAgentTasks(q agentQueryer, ids []string, groupID string) (compiledAgentTasks, error) {
	result := compiledAgentTasks{Labels: []nodeTaskLabel{}, Tasks: []nodeTaskSummary{}, LabelIDs: sortedUnique(ids), TaskIDs: []string{}}
	labels, err := readAgentTaskLabels(q)
	if err != nil {
		return result, err
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	for _, l := range labels {
		if wanted[l.ID] {
			result.Labels = append(result.Labels, nodeTaskLabel{l.ID, l.Name})
			delete(wanted, l.ID)
		}
	}
	if len(wanted) > 0 {
		return result, agentProblem(404, "任务标签不存在")
	}
	sort.Slice(result.Labels, func(i, j int) bool { return result.Labels[i].ID < result.Labels[j].ID })
	c := agent.NormalizeRemoteConfig(agent.RemoteConfig{CollectIntervalSeconds: 15, HostEnabled: boolPointer(false), HostCollectors: []string{}, LogsEnabled: boolPointer(false), GroupID: groupID})
	// Preserve old flat-config defaults and table names even when an old task is disabled.
	if groupID != "" {
		var raw string
		e := q.QueryRow(`SELECT config FROM agent_groups WHERE id=?`, groupID).Scan(&raw)
		if e == nil {
			var old agent.RemoteConfig
			if e = json.Unmarshal([]byte(raw), &old); e != nil {
				return result, e
			}
			old = agent.NormalizeRemoteConfig(old)
			c.HostTable = old.HostTable
			c.ProbeTable = old.ProbeTable
			c.LogTable = old.LogTable
			c.CollectIntervalSeconds = old.CollectIntervalSeconds
		} else if !errors.Is(e, sql.ErrNoRows) {
			return result, e
		}
	}
	all, err := readAgentTasks(q)
	if err != nil {
		return result, err
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	hostTask, probeTask, logTask := "", "", ""
	probeByID := map[string]agent.Probe{}
	probeOwner := map[string]string{}
	sourceByID := map[string]agent.LogSource{}
	sourceOwner := map[string]string{}
	included := []agentTask{}
	for _, t := range all {
		if !t.Enabled {
			continue
		}
		matches := false
		for _, id := range t.LabelIDs {
			if selected[id] {
				matches = true
				break
			}
		}
		if !matches {
			continue
		}
		included = append(included, t)
		result.Tasks = append(result.Tasks, nodeTaskSummary{t.ID, t.Name, t.Type})
		result.TaskIDs = append(result.TaskIDs, t.ID)
		conflict := func(previous, reason string) error {
			return agentProblem(409, "任务“%s”与“%s”冲突：%s", previous, t.Name, reason)
		}
		switch t.Type {
		case "host":
			if hostTask != "" && (c.HostTable != t.Config.HostTable || c.CollectIntervalSeconds != t.Config.CollectIntervalSeconds) {
				return result, conflict(hostTask, "指标上报表或采集间隔不同")
			}
			hostTask = t.Name
			c.HostEnabled = boolPointer(true)
			c.HostTable = t.Config.HostTable
			c.CollectIntervalSeconds = t.Config.CollectIntervalSeconds
			c.HostCollectors = append(c.HostCollectors, t.Config.HostCollectors...)
			c.ProcessNames = append(c.ProcessNames, t.Config.ProcessNames...)
		case "probe":
			if probeTask != "" && c.ProbeTable != t.Config.ProbeTable {
				return result, conflict(probeTask, "拨测上报表不同")
			}
			probeTask = t.Name
			c.ProbeTable = t.Config.ProbeTable
			for _, p := range t.Config.Probes {
				if old, exists := probeByID[p.ID]; exists {
					a, _ := json.Marshal(old)
					b, _ := json.Marshal(p)
					if string(a) != string(b) {
						return result, conflict(probeOwner[p.ID], "拨测 ID “"+p.ID+"”重复且参数不同")
					}
					continue
				}
				probeByID[p.ID] = p
				probeOwner[p.ID] = t.Name
				c.Probes = append(c.Probes, p)
			}
		case "log":
			if logTask != "" && c.LogTable != t.Config.LogTable {
				return result, conflict(logTask, "日志上报表不同")
			}
			logTask = t.Name
			c.LogTable = t.Config.LogTable
			c.LogsEnabled = boolPointer(true)
			for _, source := range t.Config.LogSources {
				key := fmt.Sprintf("%s\x00%s\x00%t", filepath.Clean(source.Directory), source.Pattern, source.Recursive)
				if old, exists := sourceByID[key]; exists {
					if old.FromBeginning != source.FromBeginning {
						return result, conflict(sourceOwner[key], "同一日志来源的首次采集策略不同")
					}
					continue
				}
				sourceByID[key] = source
				sourceOwner[key] = t.Name
				c.LogSources = append(c.LogSources, source)
			}
		default:
			return result, agentProblem(409, "任务“%s”的类型无效", t.Name)
		}
	}
	c.HostCollectors = sortedUnique(c.HostCollectors)
	c.ProcessNames = sortedUnique(c.ProcessNames)
	sort.Slice(c.Probes, func(i, j int) bool { return c.Probes[i].ID < c.Probes[j].ID })
	sort.Slice(c.LogSources, func(i, j int) bool {
		a, _ := json.Marshal(c.LogSources[i])
		b, _ := json.Marshal(c.LogSources[j])
		return string(a) < string(b)
	})
	c.Revision = "validate"
	if err = agent.ValidateRemoteConfig(c); err != nil {
		return result, agentProblem(409, "合并任务配置无效：%s", err)
	}
	c.Revision = ""
	raw, err := json.Marshal(struct {
		Config agent.RemoteConfig
		Labels []nodeTaskLabel
		Tasks  []agentTask
	}{c, result.Labels, included})
	if err != nil {
		return result, err
	}
	hash := sha256.Sum256(raw)
	c.Revision = hex.EncodeToString(hash[:])
	result.Config = c
	return result, nil
}
func validateAllAgentAssignments(q agentQueryer) error {
	rows, err := q.Query(`SELECT id,hostname,group_id FROM agents ORDER BY id`)
	if err != nil {
		return err
	}
	type node struct{ id, name, group string }
	nodes := []node{}
	for rows.Next() {
		var n node
		if err = rows.Scan(&n.id, &n.name, &n.group); err != nil {
			rows.Close()
			return err
		}
		nodes = append(nodes, n)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, n := range nodes {
		ids, e := nodeAgentLabelIDs(q, n.id)
		if e != nil {
			return e
		}
		if _, e = compileAgentTasks(q, ids, n.group); e != nil {
			return agentProblem(agentErrorStatus(e), "执行节点“%s”：%s", n.name, e)
		}
	}
	return nil
}
func replaceNodeAgentLabels(q agentQueryer, id string, ids []string, legacyGroup string) error {
	if len(ids) > 64 {
		return agentProblem(400, "每个执行节点最多关联 64 个任务标签")
	}
	ids = sortedUnique(ids)
	var exists int
	if err := q.QueryRow(`SELECT count(*) FROM agents WHERE id=?`, id).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return agentProblem(404, "执行节点不存在")
	}
	groupID := legacyGroup
	if groupID == "" {
		if len(ids) > 0 {
			groupID = ids[0]
		} else {
			groupID = defaultAgentGroup
		}
	}
	if _, err := compileAgentTasks(q, ids, groupID); err != nil {
		return err
	}
	if _, err := q.Exec(`DELETE FROM agent_node_labels WHERE agent_id=?`, id); err != nil {
		return err
	}
	for _, label := range ids {
		if _, err := q.Exec(`INSERT INTO agent_node_labels(agent_id,label_id) VALUES(?,?)`, id, label); err != nil {
			return err
		}
	}
	_, err := q.Exec(`UPDATE agents SET group_id=? WHERE id=?`, groupID, id)
	return err
}
