package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/shared"
)

const defaultAgentGroup = "default"

type agentGroup struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Config     agent.RemoteConfig `json:"config"`
	AgentCount int                `json:"agent_count"`
}

func (s *Server) initAgentTasks() error {
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,config TEXT NOT NULL,created_at TEXT NOT NULL)`); err != nil {
		return err
	}
	var hasGroup int
	if err := s.DB.QueryRow(`SELECT count(*) FROM pragma_table_info('agents') WHERE name='group_id'`).Scan(&hasGroup); err != nil {
		return err
	}
	if hasGroup == 0 {
		if _, err := s.DB.Exec(`ALTER TABLE agents ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default'`); err != nil {
			return err
		}
	}
	initial := agent.NormalizeRemoteConfig(agent.RemoteConfig{Revision: auth.ID(), CollectIntervalSeconds: 15})
	raw, _ := json.Marshal(initial)
	if _, err := s.DB.Exec(`INSERT OR IGNORE INTO agent_groups(id,name,config,created_at) VALUES('default','默认分组',?,?)`, string(raw), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if err := s.initIndependentAgentTasks(); err != nil {
		return err
	}
	if hasGroup == 0 {
		_, err := s.DB.Exec(`INSERT OR IGNORE INTO agent_node_labels(agent_id,label_id) SELECT id,group_id FROM agents`)
		return err
	}
	return nil
}
func readLegacyAgentGroup(q agentQueryer, id string) (agentGroup, error) {
	var group agentGroup
	if err := q.QueryRow(`SELECT g.id,COALESCE((SELECT name FROM agent_task_labels WHERE id=g.id),g.name),(SELECT count(*) FROM agent_node_labels WHERE label_id=g.id) FROM agent_groups g WHERE g.id=?`, id).Scan(&group.ID, &group.Name, &group.AgentCount); err != nil {
		return group, err
	}
	compiled, err := compileAgentTasks(q, []string{id}, id)
	group.Config = compiled.Config
	return group, err
}
func (s *Server) agentGroup(id string) (agentGroup, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return agentGroup{}, err
	}
	defer tx.Rollback()
	return readLegacyAgentGroup(tx, id)
}
func (s *Server) agentGroups() ([]agentGroup, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT id FROM agent_groups ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END,created_at,id`)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	groups := []agentGroup{}
	for _, id := range ids {
		g, e := readLegacyAgentGroup(tx, id)
		if e != nil {
			return nil, e
		}
		groups = append(groups, g)
	}
	return groups, nil
}
func (s *Server) registerAgentConfig() {
	s.registerIndependentAgentTasks()
	s.API.HandleFunc("GET /api/v1/agent-groups", func(w http.ResponseWriter, r *http.Request) {
		groups, err := s.agentGroups()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, groups)
	})
	for _, pattern := range []string{"POST /api/v1/agent-groups", "PUT /api/v1/agent-groups/{group}"} {
		s.API.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if !requireAgentAdmin(w, r) {
				return
			}
			var input struct {
				Name   string              `json:"name"`
				Config *agent.RemoteConfig `json:"config"`
			}
			if shared.Decode(r, &input) != nil || !validTaskName(input.Name) {
				shared.Error(w, 400, "请填写任务标签名称，最长 128 字节")
				return
			}
			id := r.PathValue("group")
			create := r.Method == "POST"
			conf := agent.NormalizeRemoteConfig(agent.RemoteConfig{CollectIntervalSeconds: 15})
			tx, err := s.DB.Begin()
			if err != nil {
				respondAgentError(w, err)
				return
			}
			defer tx.Rollback()
			if !create {
				var stored string
				if err = tx.QueryRow(`SELECT config FROM agent_groups WHERE id=?`, id).Scan(&stored); err != nil {
					respondAgentError(w, err)
					return
				}
				if err = json.Unmarshal([]byte(stored), &conf); err != nil {
					respondAgentError(w, err)
					return
				}
				// A combined GET is not the source of the three legacy tasks.
				// Reusing it here would clone independently managed work.
				if input.Config != nil {
					if err = guardLegacyTaskWrite(tx, id); err != nil {
						respondAgentError(w, err)
						return
					}
				}
			} else {
				id = auth.ID()
			}
			if input.Config != nil {
				conf = *input.Config
			}
			conf = agent.NormalizeRemoteConfig(conf)
			conf.GroupID = ""
			conf.Revision = auth.ID()
			if err = agent.ValidateRemoteConfig(conf); err != nil {
				shared.Error(w, 400, "任务配置无效："+err.Error())
				return
			}
			raw, _ := json.Marshal(conf)
			name := strings.TrimSpace(input.Name)
			if create {
				_, err = tx.Exec(`INSERT INTO agent_groups(id,name,config,created_at) VALUES(?,?,?,?)`, id, name, string(raw), time.Now().UTC().Format(time.RFC3339Nano))
				if err == nil {
					_, err = tx.Exec(`INSERT INTO agent_task_labels(id,name,created_at) VALUES(?,?,?)`, id, name, time.Now().UTC().Format(time.RFC3339Nano))
				}
			} else {
				_, err = tx.Exec(`UPDATE agent_groups SET name=?,config=? WHERE id=?`, name, string(raw), id)
				if err == nil {
					_, err = tx.Exec(`UPDATE agent_task_labels SET name=? WHERE id=?`, name, id)
				}
			}
			if err != nil {
				if strings.Contains(err.Error(), "UNIQUE constraint failed") {
					err = agentProblem(409, "任务标签名称已存在")
				}
				respondAgentError(w, err)
				return
			}
			if create || input.Config != nil {
				err = writeLegacyAgentTasks(tx, id, name, conf)
			}
			if err == nil {
				err = validateAllAgentAssignments(tx)
			}
			if err == nil {
				err = tx.Commit()
			}
			if err != nil {
				respondAgentError(w, err)
				return
			}
			group, err := s.agentGroup(id)
			if err != nil {
				respondAgentError(w, err)
				return
			}
			status := 200
			if create {
				status = 201
			}
			shared.JSON(w, status, group)
		})
	}
	s.API.HandleFunc("PUT /api/v1/agents/{id}/group", func(w http.ResponseWriter, r *http.Request) {
		if !requireAgentAdmin(w, r) {
			return
		}
		var input struct {
			GroupID string `json:"group_id"`
		}
		if shared.Decode(r, &input) != nil || input.GroupID == "" {
			shared.Error(w, 400, "请选择初始任务标签")
			return
		}
		tx, err := s.DB.Begin()
		if err != nil {
			respondAgentError(w, err)
			return
		}
		defer tx.Rollback()
		if err = replaceNodeAgentLabels(tx, r.PathValue("id"), []string{input.GroupID}, input.GroupID); err == nil {
			err = tx.Commit()
		}
		if err != nil {
			respondAgentError(w, err)
			return
		}
		group, err := s.agentGroup(input.GroupID)
		if err != nil {
			respondAgentError(w, err)
			return
		}
		shared.JSON(w, 200, group)
	})
	s.API.HandleFunc("DELETE /api/v1/agent-groups/{group}", func(w http.ResponseWriter, r *http.Request) {
		if !requireAgentAdmin(w, r) {
			return
		}
		id := r.PathValue("group")
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
		if err = tx.QueryRow(`SELECT count(*) FROM agent_groups WHERE id=?`, id).Scan(&exists); err != nil {
			respondAgentError(w, err)
			return
		}
		if exists == 0 {
			shared.Error(w, 404, "任务标签不存在")
			return
		}
		if err = tx.QueryRow(`SELECT count(*) FROM agent_node_labels WHERE label_id=?`, id).Scan(&refs); err != nil {
			respondAgentError(w, err)
			return
		}
		if refs > 0 {
			shared.Error(w, 409, "请先解除执行节点与该任务标签的关联")
			return
		}
		if err = guardLegacyTaskWrite(tx, id); err != nil {
			respondAgentError(w, err)
			return
		}
		// A legacy delete may remove only its own migrated tasks, never independent tasks.
		if err = tx.QueryRow(`SELECT count(*) FROM agent_task_targets WHERE label_id=? AND task_id NOT IN (?,?,?)`, id, "legacy:"+id+":host", "legacy:"+id+":probe", "legacy:"+id+":log").Scan(&refs); err != nil {
			respondAgentError(w, err)
			return
		}
		if refs > 0 {
			shared.Error(w, 409, "请先解除任务与该标签的关联")
			return
		}
		if err = tx.QueryRow(`SELECT count(*) FROM agent_task_targets WHERE label_id<>? AND task_id IN (?,?,?)`, id, "legacy:"+id+":host", "legacy:"+id+":probe", "legacy:"+id+":log").Scan(&refs); err != nil {
			respondAgentError(w, err)
			return
		}
		if refs > 0 {
			shared.Error(w, 409, "原迁移任务已关联其他任务标签，请在任务管理中调整后重试")
			return
		}
		if _, err = tx.Exec(`DELETE FROM agent_tasks WHERE id IN (?,?,?)`, "legacy:"+id+":host", "legacy:"+id+":probe", "legacy:"+id+":log"); err == nil {
			_, err = tx.Exec(`DELETE FROM agent_task_labels WHERE id=?`, id)
		}
		if err == nil {
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
}

// Once the new task API gives a label independent work, old full-bundle writes
// cannot safely determine which returned fields are owned by the legacy tasks.
func guardLegacyTaskWrite(q agentQueryer, labelID string) error {
	tasks, err := readAgentTasks(q)
	if err != nil {
		return err
	}
	for _, task := range tasks {
		expected := ""
		for _, kind := range []string{"host", "probe", "log"} {
			if task.ID == "legacy:"+labelID+":"+kind {
				expected = kind
			}
		}
		if expected != "" {
			if task.Type != expected || len(task.LabelIDs) != 1 || task.LabelIDs[0] != labelID {
				return agentProblem(409, "迁移任务已独立调整，请在任务管理中修改配置")
			}
			continue
		}
		for _, target := range task.LabelIDs {
			if target == labelID {
				return agentProblem(409, "该任务标签已使用独立任务，请在任务管理中修改配置")
			}
		}
	}
	return nil
}
