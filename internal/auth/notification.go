package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func ValidateNotificationProfile(p *shared.NotificationProfile) error {
	p.Email = strings.TrimSpace(p.Email)
	p.Phone = strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(p.Phone), " ", ""), "-", "")
	if p.Email != "" {
		v, e := mail.ParseAddress(p.Email)
		if e != nil || v.Address != p.Email {
			return errors.New("请输入有效的收件邮箱")
		}
	}
	if p.Phone != "" {
		if regexp.MustCompile(`^1[3-9][0-9]{9}$`).MatchString(p.Phone) {
			p.Phone = "+86" + p.Phone
		}
		if !regexp.MustCompile(`^\+[1-9][0-9]{6,14}$`).MatchString(p.Phone) {
			return &profileError{"手机号需要国家区号，例如 +8613800000000"}
		}
	}
	if p.Timezone == "" {
		p.Timezone = "Asia/Shanghai"
	}
	if _, e := time.LoadLocation(p.Timezone); e != nil {
		return e
	}
	for _, value := range []string{p.FeishuID, p.DingtalkID, p.WecomID} {
		if len(value) > 256 || strings.ContainsAny(value, "\r\n") {
			return &profileError{"无效的通知用户 ID"}
		}
	}
	return nil
}

type profileError struct{ text string }

func (e *profileError) Error() string { return e.text }

func (a *Auth) notificationProfile(id string) shared.NotificationProfile {
	p := shared.NotificationProfile{UserID: id, Timezone: "Asia/Shanghai"}
	var raw string
	if a.DB.QueryRow("SELECT body FROM user_notification_profiles WHERE user_id=?", id).Scan(&raw) == nil {
		_ = json.Unmarshal([]byte(raw), &p)
	}
	return p
}

func (a *Auth) registerNotificationProfiles(mux *http.ServeMux) {
	get := func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			id = shared.CurrentUser(r).ID
		}
		if id != shared.CurrentUser(r).ID && !shared.IsAdmin(r) {
			shared.Error(w, 403, "只能查看自己的告警联系方式")
			return
		}
		shared.JSON(w, 200, a.notificationProfile(id))
	}
	put := func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			id = shared.CurrentUser(r).ID
		}
		if id != shared.CurrentUser(r).ID && !shared.IsAdmin(r) {
			shared.Error(w, 403, "只能修改自己的告警联系方式")
			return
		}
		var p shared.NotificationProfile
		if shared.Decode(r, &p) != nil {
			shared.Error(w, 400, "无效的联系方式")
			return
		}
		if e := ValidateNotificationProfile(&p); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		var exists int
		if a.DB.QueryRow("SELECT count(*) FROM users WHERE id=?", id).Scan(&exists) != nil || exists != 1 {
			shared.Error(w, 404, "用户不存在")
			return
		}
		p.UserID, p.Source, p.UpdatedAt = id, "manual", time.Now().UTC().Format(time.RFC3339Nano)
		if _, e := a.DB.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body", id, encoded(p)); e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		shared.JSON(w, 200, p)
	}
	mux.HandleFunc("GET /api/v1/auth/notification-profile", get)
	mux.HandleFunc("PUT /api/v1/auth/notification-profile", put)
	mux.HandleFunc("GET /api/v1/users/{id}/notification-profile", get)
	mux.HandleFunc("PUT /api/v1/users/{id}/notification-profile", put)
}

func (a *Auth) syncNotificationProfile(userID string, p Provider, identity map[string]any) error {
	v := a.notificationProfile(userID)
	if v.Source == "manual" {
		return nil
	}
	for _, mapping := range []struct {
		field  string
		target *string
	}{{p.EmailField, &v.Email}, {p.PhoneField, &v.Phone}, {p.FeishuIDField, &v.FeishuID}, {p.DingtalkIDField, &v.DingtalkID}, {p.WecomIDField, &v.WecomID}} {
		if mapping.field != "" {
			*mapping.target = field(identity, mapping.field)
		}
	}
	if e := ValidateNotificationProfile(&v); e != nil {
		return e
	}
	v.Source, v.UpdatedAt = "sso:"+p.ID, time.Now().UTC().Format(time.RFC3339Nano)
	_, e := a.DB.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body", userID, encoded(v))
	return e
}
