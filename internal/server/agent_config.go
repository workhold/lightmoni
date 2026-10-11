package server

import (
	"database/sql"
	"encoding/json"
	"errors"
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
	if _, err := s.DB.Exec("CREATE TABLE IF NOT EXISTS agent_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,config TEXT NOT NULL,created_at TEXT NOT NULL)"); err != nil {
		return err
	}
	var hasGroup int
	if err := s.DB.QueryRow("SELECT count(*) FROM pragma_table_info('agents') WHERE name='group_id'").Scan(&hasGroup); err != nil {
		return err
	}
	if hasGroup == 0 {
		if _, err := s.DB.Exec("ALTER TABLE agents ADD COLUMN group_id TEXT NOT NULL DEFAULT 'default'"); err != nil {
			return err
		}
	}
	initial := agent.NormalizeRemoteConfig(agent.RemoteConfig{Revision: auth.ID(), CollectIntervalSeconds: 15})
	raw, _ := json.Marshal(initial)
	_, err := s.DB.Exec("INSERT OR IGNORE INTO agent_groups(id,name,config,created_at) VALUES('default','默认分组',?,?)", string(raw), time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Server) agentGroup(id string) (agentGroup, error) {
	var group agentGroup
	var raw string
	err := s.DB.QueryRow("SELECT id,name,config,(SELECT count(*) FROM agents WHERE group_id=g.id) FROM agent_groups g WHERE id=?", id).Scan(&group.ID, &group.Name, &raw, &group.AgentCount)
	if err != nil {
		return group, err
	}
	if err = json.Unmarshal([]byte(raw), &group.Config); err != nil {
		return group, err
	}
	group.Config = agent.NormalizeRemoteConfig(group.Config)
	group.Config.GroupID = group.ID
	return group, agent.ValidateRemoteConfig(group.Config)
}

func (s *Server) agentGroups() ([]agentGroup, error) {
	rows, err := s.DB.Query("SELECT id,name,config,(SELECT count(*) FROM agents WHERE group_id=g.id) FROM agent_groups g ORDER BY CASE WHEN id='default' THEN 0 ELSE 1 END,created_at")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := []agentGroup{}
	for rows.Next() {
		var group agentGroup
		var raw string
		if err = rows.Scan(&group.ID, &group.Name, &raw, &group.AgentCount); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &group.Config); err != nil {
			return nil, err
		}
		group.Config = agent.NormalizeRemoteConfig(group.Config)
		group.Config.GroupID = group.ID
		groups = append(groups, group)
	}
	return groups, rows.Err()
}

func (s *Server) registerAgentConfig() {
	s.API.HandleFunc("GET /api/v1/agent-groups", func(w http.ResponseWriter, r *http.Request) {
		groups, err := s.agentGroups()
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		shared.JSON(w, 200, groups)
	})
	for _, method := range []string{"POST /api/v1/agent-groups", "PUT /api/v1/agent-groups/{group}"} {
		s.API.HandleFunc(method, func(w http.ResponseWriter, r *http.Request) {
			if !shared.IsAdmin(r) {
				shared.Error(w, 403, "需要管理员权限")
				return
			}
			var input struct {
				Name   string              `json:"name"`
				Config *agent.RemoteConfig `json:"config"`
			}
			if shared.Decode(r, &input) != nil || strings.TrimSpace(input.Name) == "" || len(input.Name) > 128 {
				shared.Error(w, 400, "请填写分组名称，最长 128 字节")
				return
			}
			id := r.PathValue("group")
			conf := agent.NormalizeRemoteConfig(agent.RemoteConfig{CollectIntervalSeconds: 15})
			if id != "" {
				old, err := s.agentGroup(id)
				if err != nil {
					if errors.Is(err, sql.ErrNoRows) {
						shared.Error(w, 404, "分组不存在")
					} else {
						shared.Error(w, 500, err.Error())
					}
					return
				}
				conf = old.Config
			} else {
				id = auth.ID()
			}
			if input.Config != nil {
				conf = *input.Config
			}
			conf = agent.NormalizeRemoteConfig(conf)
			conf.GroupID = ""
			conf.Revision = auth.ID()
			if err := agent.ValidateRemoteConfig(conf); err != nil {
				shared.Error(w, 400, "任务配置无效："+err.Error())
				return
			}
			raw, _ := json.Marshal(conf)
			var err error
			if r.Method == "POST" {
				_, err = s.DB.Exec("INSERT INTO agent_groups(id,name,config,created_at) VALUES(?,?,?,?)", id, strings.TrimSpace(input.Name), string(raw), time.Now().UTC().Format(time.RFC3339Nano))
			} else {
				_, err = s.DB.Exec("UPDATE agent_groups SET name=?,config=? WHERE id=?", strings.TrimSpace(input.Name), string(raw), id)
			}
			if err != nil {
				if strings.Contains(err.Error(), "UNIQUE constraint failed: agent_groups.name") {
					shared.Error(w, 409, "分组名称已存在")
				} else {
					shared.Error(w, 500, err.Error())
				}
				return
			}
			group, err := s.agentGroup(id)
			if err != nil {
				shared.Error(w, 500, err.Error())
				return
			}
			status := 200
			if r.Method == "POST" {
				status = 201
			}
			shared.JSON(w, status, group)
		})
	}
	s.API.HandleFunc("PUT /api/v1/agents/{id}/group", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "需要管理员权限")
			return
		}
		var input struct {
			GroupID string `json:"group_id"`
		}
		if shared.Decode(r, &input) != nil || input.GroupID == "" {
			shared.Error(w, 400, "请选择 Agent 分组")
			return
		}
		group, err := s.agentGroup(input.GroupID)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				shared.Error(w, 404, "分组不存在")
			} else {
				shared.Error(w, 500, err.Error())
			}
			return
		}
		result, err := s.DB.Exec("UPDATE agents SET group_id=? WHERE id=? AND EXISTS(SELECT 1 FROM agent_groups WHERE id=?)", input.GroupID, r.PathValue("id"), input.GroupID)
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		n, err := result.RowsAffected()
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		if n == 0 {
			shared.Error(w, 404, "Agent 不存在")
			return
		}
		shared.JSON(w, 200, group)
	})
	s.API.HandleFunc("DELETE /api/v1/agent-groups/{group}", func(w http.ResponseWriter, r *http.Request) {
		if !shared.IsAdmin(r) {
			shared.Error(w, 403, "需要管理员权限")
			return
		}
		id := r.PathValue("group")
		if id == defaultAgentGroup {
			shared.Error(w, 409, "默认分组不能删除")
			return
		}
		result, err := s.DB.Exec("DELETE FROM agent_groups WHERE id=? AND NOT EXISTS(SELECT 1 FROM agents WHERE group_id=?)", id, id)
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		n, err := result.RowsAffected()
		if err != nil {
			shared.Error(w, 500, err.Error())
			return
		}
		if n == 0 {
			if _, err = s.agentGroup(id); errors.Is(err, sql.ErrNoRows) {
				shared.Error(w, 404, "分组不存在")
			} else {
				shared.Error(w, 409, "请先将这个分组的 Agent 移到其他分组")
			}
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
}
