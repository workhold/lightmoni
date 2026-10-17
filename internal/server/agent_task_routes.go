package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/shared"
)

func respondAgentError(w http.ResponseWriter, err error) {
	status := agentErrorStatus(err)
	if errors.Is(err, sql.ErrNoRows) {
		shared.Error(w, 404, "执行节点或任务标签不存在")
		return
	}
	if status == 500 {
		shared.Error(w, status, "执行节点任务暂不可用")
		return
	}
	shared.Error(w, status, err.Error())
}
func requireAgentAdmin(w http.ResponseWriter, r *http.Request) bool {
	if !shared.IsAdmin(r) {
		shared.Error(w, 403, "需要管理员权限")
		return false
	}
	return true
}
func (s *Server) registerIndependentAgentTasks() {
	s.API.HandleFunc("GET /api/v1/agent-task-labels", func(w http.ResponseWriter, r *http.Request) {
		labels, err := readAgentTaskLabels(s.DB)
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, labels)
	})
	for _, pattern := range []string{"POST /api/v1/agent-task-labels", "PUT /api/v1/agent-task-labels/{id}"} {
		s.API.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if !requireAgentAdmin(w, r) {
				return
			}
			var input struct {
				Name string `json:"name"`
			}
			if shared.Decode(r, &input) != nil || !validTaskName(input.Name) {
				shared.Error(w, 400, "请填写任务标签名称，最长 128 字节")
				return
			}
			name := strings.TrimSpace(input.Name)
			id := r.PathValue("id")
			create := r.Method == "POST"
			if create {
				id = auth.ID()
			}
			tx, err := s.DB.Begin()
			if err != nil {
				respondAgentError(w, err)
				return
			}
			defer tx.Rollback()
			if create {
				_, err = tx.Exec(`INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)`, id, name, time.Now().UTC().Format(time.RFC3339Nano))
			} else {
				var result sql.Result
				result, err = tx.Exec(`UPDATE agent_task_labels SET name=? WHERE id=?`, name, id)
				if err == nil {
					n, _ := result.RowsAffected()
					if n == 0 {
						err = agentProblem(404, "任务标签不存在")
					}
				}
			}
			if err != nil {
				if strings.Contains(err.Error(), "UNIQUE constraint failed") {
					err = agentProblem(409, "任务标签名称已存在")
				}
				respondAgentError(w, err)
				return
			}
			if create {
				off := false
				c := agent.NormalizeRemoteConfig(agent.RemoteConfig{Revision: "initial", CollectIntervalSeconds: 15, HostEnabled: &off, HostCollectors: []string{}})
				raw, _ := json.Marshal(c)
				_, err = tx.Exec(`INSERT INTO agent_groups(id,name,config,created_at) VALUES(?,?,?,?)`, id, name, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
			} else {
				_, err = tx.Exec(`UPDATE agent_groups SET name=? WHERE id=?`, name, id)
			}
			if err != nil {
				if strings.Contains(err.Error(), "UNIQUE constraint failed") {
					err = agentProblem(409, "任务标签名称与已有兼容配置冲突")
				}
				respondAgentError(w, err)
				return
			}
			if err = validateAllAgentAssignments(tx); err != nil {
				respondAgentError(w, err)
				return
			}
			if err = tx.Commit(); err != nil {
				respondAgentError(w, err)
				return
			}
			labels, err := readAgentTaskLabels(s.DB)
			if err != nil {
				respondAgentError(w, err)
				return
			}
			for _, l := range labels {
				if l.ID == id {
					status := 200
					if create {
						status = 201
					}
					shared.JSON(w, status, l)
					return
				}
			}
		})
	}
	s.API.HandleFunc("DELETE /api/v1/agent-task-labels/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAgentAdmin(w, r) {
			return
		}
		id := r.PathValue("id")
		if id == defaultAgentGroup {
			shared.Error(w, 409, "默认任务标签不能删除")
			return
		}
		tx, err := s.DB.Begin()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		defer tx.Rollback()
		var exists, refs int
		if err = tx.QueryRow(`SELECT count(*) FROM agent_task_labels WHERE id=?`, id).Scan(&exists); err != nil {
			respondAgentError(w, err)
			return
		}
		if exists == 0 {
			shared.Error(w, 404, "任务标签不存在")
			return
		}
		if err = tx.QueryRow(`SELECT (SELECT count(*) FROM agent_node_labels WHERE label_id=?)+(SELECT count(*) FROM agent_task_targets WHERE label_id=?)`, id, id).Scan(&refs); err != nil {
			respondAgentError(w, err)
			return
		}
		if refs > 0 {
			shared.Error(w, 409, "请先解除执行节点和任务对该标签的关联")
			return
		}
		if _, err = tx.Exec(`DELETE FROM agent_task_labels WHERE id=?`, id); err == nil {
			_, err = tx.Exec(`DELETE FROM agent_groups WHERE id=?`, id)
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	s.API.HandleFunc("GET /api/v1/agent-tasks", func(w http.ResponseWriter, r *http.Request) {
		tasks, err := readAgentTasks(s.DB)
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, tasks)
	})
	for _, pattern := range []string{"POST /api/v1/agent-tasks", "PUT /api/v1/agent-tasks/{id}"} {
		s.API.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if !requireAgentAdmin(w, r) {
				return
			}
			var input agentTask
			if shared.Decode(r, &input) != nil {
				shared.Error(w, 400, "任务配置无效")
				return
			}
			if err := normalizeAgentTask(&input); err != nil {
				respondAgentError(w, err)
				return
			}
			id := r.PathValue("id")
			create := r.Method == "POST"
			if create {
				id = auth.ID()
			}
			input.ID = id
			tx, err := s.DB.Begin()
			if err != nil {
				respondAgentError(w, err)
				return
			}
			defer tx.Rollback()
			if !create {
				var exists int
				if err = tx.QueryRow(`SELECT count(*) FROM agent_tasks WHERE id=?`, id).Scan(&exists); err != nil {
					respondAgentError(w, err)
					return
				}
				if exists == 0 {
					shared.Error(w, 404, "任务不存在")
					return
				}
			}
			if err = saveAgentTask(tx, input); err == nil {
				err = validateAllAgentAssignments(tx)
			}
			if err == nil {
				err = tx.Commit()
			}
			if err != nil {
				respondAgentError(w, err)
				return
			}
			status := 200
			if create {
				status = 201
			}
			shared.JSON(w, status, input)
		})
	}
	s.API.HandleFunc("DELETE /api/v1/agent-tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAgentAdmin(w, r) {
			return
		}
		tx, err := s.DB.Begin()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		defer tx.Rollback()
		result, err := tx.Exec(`DELETE FROM agent_tasks WHERE id=?`, r.PathValue("id"))
		if err != nil {
			respondAgentError(w, err)
			return
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			shared.Error(w, 404, "任务不存在")
			return
		}
		if err = validateAllAgentAssignments(tx); err == nil {
			err = tx.Commit()
		}
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	s.API.HandleFunc("PUT /api/v1/agents/{id}/labels", func(w http.ResponseWriter, r *http.Request) {
		if !requireAgentAdmin(w, r) {
			return
		}
		var input struct {
			LabelIDs *[]string `json:"label_ids"`
		}
		if shared.Decode(r, &input) != nil || input.LabelIDs == nil {
			shared.Error(w, 400, "请提供任务标签列表，可为空数组")
			return
		}
		tx, err := s.DB.Begin()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		defer tx.Rollback()
		if err = replaceNodeAgentLabels(tx, r.PathValue("id"), *input.LabelIDs, ""); err == nil {
			err = tx.Commit()
		}
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, map[string]any{"label_ids": sortedUnique(*input.LabelIDs)})
	})
}

func (s *Server) recordAgentHeartbeat(id string, v map[string]any, key string) error {
	text := func(field string) string {
		if v[field] == nil {
			return ""
		}
		return strings.TrimSpace(fmt.Sprint(v[field]))
	}
	groupID := text("group_id")
	if groupID == "" {
		groupID = defaultAgentGroup
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existing string
	err = tx.QueryRow(`SELECT group_id FROM agents WHERE id=?`, id).Scan(&existing)
	newNode := errors.Is(err, sql.ErrNoRows)
	if err != nil && !newNode {
		return err
	}
	if !newNode {
		groupID = existing
	} else {
		if _, err = compileAgentTasks(tx, []string{groupID}, groupID); err != nil {
			status := agentErrorStatus(err)
			if status == 404 {
				status = 400
			}
			if status == 500 {
				return err
			}
			return agentProblem(status, "初始任务标签无效或任务冲突，请重新选择标签：%s", err)
		}
	}
	// The caller persists runtime events before entering this single-connection transaction.
	v["runtime_key_id"] = key
	delete(v, "runtime_events")
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO agents(id,host_id,hostname,version,platform,arch,last_seen,heartbeat,group_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET hostname=excluded.hostname,version=excluded.version,platform=excluded.platform,arch=excluded.arch,last_seen=excluded.last_seen,heartbeat=excluded.heartbeat`, id, text("host_id"), text("hostname"), text("version"), text("platform"), text("arch"), time.Now().UTC().Format(time.RFC3339Nano), string(raw), groupID)
	if err != nil {
		return err
	}
	if newNode {
		if _, err = tx.Exec(`INSERT INTO agent_node_labels(agent_id,label_id) VALUES(?,?)`, id, groupID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Server) nodeEffectiveAgentTasks(id string) (compiledAgentTasks, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return compiledAgentTasks{}, err
	}
	defer tx.Rollback()
	var groupID string
	if err = tx.QueryRow(`SELECT group_id FROM agents WHERE id=?`, id).Scan(&groupID); err != nil {
		return compiledAgentTasks{}, err
	}
	ids, err := nodeAgentLabelIDs(tx, id)
	if err != nil {
		return compiledAgentTasks{}, err
	}
	return compileAgentTasks(tx, ids, groupID)
}
func (s *Server) listExecutionNodes() ([]map[string]any, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id,hostname,version,platform,arch,last_seen,heartbeat,group_id FROM agents ORDER BY last_seen DESC,id`)
	if err != nil {
		return nil, err
	}
	nodes := []map[string]any{}
	for rows.Next() {
		var id, name, version, platform, arch, seen, raw, groupID string
		if err = rows.Scan(&id, &name, &version, &platform, &arch, &seen, &raw, &groupID); err != nil {
			rows.Close()
			return nil, err
		}
		var heartbeat any
		if err = json.Unmarshal([]byte(raw), &heartbeat); err != nil {
			rows.Close()
			return nil, err
		}
		nodes = append(nodes, map[string]any{"id": id, "hostname": name, "version": version, "platform": platform, "arch": arch, "last_seen": seen, "heartbeat": heartbeat, "group_id": groupID})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for _, node := range nodes {
		id := node["id"].(string)
		ids, e := nodeAgentLabelIDs(tx, id)
		if e != nil {
			return nil, e
		}
		compiled, e := compileAgentTasks(tx, ids, node["group_id"].(string))
		if e != nil {
			return nil, e
		}
		node["label_ids"] = compiled.LabelIDs
		node["labels"] = compiled.Labels
		node["task_ids"] = compiled.TaskIDs
		node["tasks"] = compiled.Tasks
		node["config"] = compiled.Config
		node["group_name"] = ""
		for _, l := range compiled.Labels {
			if l.ID == node["group_id"] {
				node["group_name"] = l.Name
			}
		}
	}
	return nodes, nil
}
