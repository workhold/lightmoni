package alerts

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"time"

	"github.com/lightmoni/lightmoni/internal/auth"
	"github.com/lightmoni/lightmoni/internal/shared"
)

type DirectorySource struct {
	ID              string `json:"id"`
	Revision        int    `json:"revision"`
	Name            string `json:"name"`
	URL             string `json:"url"`
	Token           string `json:"token,omitempty"`
	HasToken        bool   `json:"has_token"`
	GroupID         string `json:"group_id"`
	Enabled         bool   `json:"enabled"`
	IntervalSeconds int    `json:"interval_seconds"`
	LastSync        string `json:"last_sync"`
	LastAttempt     string `json:"last_attempt"`
	Error           string `json:"error"`
}

func (m *Module) registerDirectoryAPI(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/settings/alert-directory-sources", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		v, e := listBodies[DirectorySource](r.Context(), m.deps.DB, "SELECT body FROM alert_directory_sources")
		respond(w, v, e)
	})
	mux.HandleFunc("PUT /api/v1/settings/alert-directory-sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var v DirectorySource
		if shared.Decode(r, &v) != nil {
			shared.Error(w, 400, "无效的目录配置")
			return
		}
		u, e := url.Parse(v.URL)
		if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
			shared.Error(w, 400, "Hook需要有效HTTP(S)地址")
			return
		}
		if v.Name == "" || v.IntervalSeconds < 60 || v.IntervalSeconds > 86400 {
			shared.Error(w, 400, "名称必填，同步间隔为60到86400秒")
			return
		}
		if _, e = m.group(r.Context(), v.GroupID); e != nil {
			shared.Error(w, 400, "告警组不存在")
			return
		}
		v.ID = r.PathValue("id")
		m.mu.Lock()
		defer m.mu.Unlock()
		var oldRaw string
		var old DirectorySource
		if m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_directory_sources WHERE id=?", v.ID).Scan(&oldRaw) == nil {
			_ = json.Unmarshal([]byte(oldRaw), &old)
		}
		if old.ID != "" && old.Revision != v.Revision {
			shared.Error(w, 409, "目录配置已变更，请刷新后重试")
			return
		}
		v.Revision = old.Revision + 1
		v.LastAttempt, v.LastSync, v.Error = old.LastAttempt, old.LastSync, old.Error
		var secret string
		if v.Token == "" {
			_ = m.deps.DB.QueryRowContext(r.Context(), "SELECT secret FROM alert_directory_sources WHERE id=?", v.ID).Scan(&secret)
		} else {
			secret, e = m.deps.Encrypt(v.Token)
			if e != nil {
				respond(w, nil, e)
				return
			}
		}
		v.Token = ""
		v.HasToken = secret != ""
		_, e = m.deps.DB.ExecContext(r.Context(), "INSERT INTO alert_directory_sources(id,body,secret) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,secret=excluded.secret", v.ID, encode(v), secret)
		respond(w, v, e)
	})
	mux.HandleFunc("POST /api/v1/settings/alert-directory-sources/{id}/sync", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		var raw string
		if m.deps.DB.QueryRowContext(r.Context(), "SELECT body FROM alert_directory_sources WHERE id=?", r.PathValue("id")).Scan(&raw) != nil {
			shared.Error(w, 404, "目录不存在")
			return
		}
		var v DirectorySource
		_ = json.Unmarshal([]byte(raw), &v)
		e := m.syncDirectory(r.Context(), v)
		if e != nil {
			shared.Error(w, 502, e.Error())
			return
		}
		shared.JSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("DELETE /api/v1/settings/alert-directory-sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !admin(w, r) {
			return
		}
		_, e := m.deps.DB.ExecContext(r.Context(), "DELETE FROM alert_directory_sources WHERE id=?", r.PathValue("id"))
		respond(w, map[string]bool{"ok": true}, e)
	})
}
func (m *Module) syncDirectory(ctx context.Context, s DirectorySource) (result error) {
	s.LastAttempt = stamp(m.now())
	defer func() {
		if result != nil {
			s.Error = "目录同步失败，保留最近成功成员：" + result.Error()
		} else {
			s.Error = ""
			s.LastSync = s.LastAttempt
		}
		_, _ = m.deps.DB.ExecContext(ctx, "UPDATE alert_directory_sources SET body=json_set(body,'$.last_attempt',?,'$.last_sync',?,'$.error',?) WHERE id=? AND coalesce(json_extract(body,'$.revision'),0)=?", s.LastAttempt, s.LastSync, s.Error, s.ID, s.Revision)
	}()
	limited, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(limited, "POST", s.URL, bytes.NewBufferString(encode(map[string]any{"group_id": s.GroupID, "at": stamp(m.now())})))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	var secret string
	if m.deps.DB.QueryRowContext(ctx, "SELECT secret FROM alert_directory_sources WHERE id=?", s.ID).Scan(&secret) == nil && secret != "" {
		token, e := m.deps.Decrypt(secret)
		if e != nil {
			return e
		}
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, e := m.client.Do(req)
	if e != nil {
		return fmt.Errorf("无法访问目录接口")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("目录HTTP %d", resp.StatusCode)
	}
	raw, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if e != nil || len(raw) > 1<<20 {
		return fmt.Errorf("目录响应超限或读取失败")
	}
	var data struct {
		Members []struct {
			UserID     string                     `json:"user_id"`
			ProviderID string                     `json:"provider_id"`
			Subject    string                     `json:"subject"`
			Profile    shared.NotificationProfile `json:"profile"`
		} `json:"members"`
		Schedule *OnCallSchedule `json:"schedule"`
		Primary  []string        `json:"primary"`
		Backup   []string        `json:"backup"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Members == nil || len(data.Members) > 100 {
		return fmt.Errorf("目录应返回不超过100人的members数组")
	}
	g, e := m.group(ctx, s.GroupID)
	if e != nil {
		return e
	}
	members := []string{}
	profiles := map[string]shared.NotificationProfile{}
	for _, v := range data.Members {
		uid := v.UserID
		if uid == "" && v.ProviderID != "" && v.Subject != "" {
			if e = m.deps.DB.QueryRowContext(ctx, "SELECT user_id FROM external_identities WHERE provider_id=? AND subject=?", v.ProviderID, v.Subject).Scan(&uid); e != nil {
				return fmt.Errorf("目录身份尚未绑定本地用户")
			}
		}
		if _, _, active := m.member(ctx, uid); !active {
			return fmt.Errorf("目录包含未知或停用用户")
		}
		p := v.Profile
		p.UserID = uid
		if e = auth.ValidateNotificationProfile(&p); e != nil {
			return fmt.Errorf("目录联系方式无效：%s", e)
		}
		p.Source = "directory:" + s.ID
		p.UpdatedAt = stamp(m.now())
		members = append(members, uid)
		profiles[uid] = p
	}
	if len(members) == 0 {
		return fmt.Errorf("空目录不会清空正在使用的值班组，请在本地明确修改")
	}
	g.Members = uniqueUsers(members)
	if data.Primary != nil {
		g.Primary = data.Primary
	}
	if data.Backup != nil {
		g.Backup = data.Backup
	}
	if data.Schedule != nil {
		g.Schedule = *data.Schedule
	}
	g.Revision++
	if e = m.validateGroupResponse(ctx, &g); e != nil {
		return e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var sourceRevision, groupRevision int
	if e = tx.QueryRow("SELECT coalesce(json_extract(body,'$.revision'),0) FROM alert_directory_sources WHERE id=?", s.ID).Scan(&sourceRevision); e != nil || sourceRevision != s.Revision {
		return fmt.Errorf("目录配置已变更，本次结果已丢弃")
	}
	if e = tx.QueryRow("SELECT json_extract(body,'$.revision') FROM alert_groups WHERE id=?", g.ID).Scan(&groupRevision); e != nil || groupRevision != g.Revision-1 {
		return fmt.Errorf("告警组已变更，本次结果已丢弃")
	}
	for uid, p := range profiles {
		var oldRaw string
		var old shared.NotificationProfile
		if tx.QueryRow("SELECT body FROM user_notification_profiles WHERE user_id=?", uid).Scan(&oldRaw) == nil {
			_ = json.Unmarshal([]byte(oldRaw), &old)
		}
		if old.Source == "manual" {
			continue
		}
		if _, e = tx.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body", uid, encode(p)); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("UPDATE alert_groups SET body=? WHERE id=?", encode(g), g.ID); e != nil {
		return e
	}
	return tx.Commit()
}
func (m *Module) SyncDueDirectories(ctx context.Context) error {
	list, e := listBodies[DirectorySource](ctx, m.deps.DB, "SELECT body FROM alert_directory_sources")
	if e != nil {
		return e
	}
	// Oldest attempts first so a short interval or failing source cannot starve
	// other configured groups. A bounded sweep keeps network work predictable.
	sort.SliceStable(list, func(i, j int) bool { return parse(list[i].LastAttempt).Before(parse(list[j].LastAttempt)) })
	attempted := 0
	for _, s := range list {
		if s.Enabled && (s.LastAttempt == "" || m.now().Sub(parse(s.LastAttempt)) >= time.Duration(s.IntervalSeconds)*time.Second) {
			_ = m.syncDirectory(ctx, s)
			attempted++
			if attempted >= 10 || ctx.Err() != nil {
				break
			}
		}
	}
	return nil
}
