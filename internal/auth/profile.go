package auth

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type personalProfile struct {
	Nickname   string `json:"nickname"`
	AvatarURL  string `json:"avatar_url"`
	Phone      string `json:"phone"`
	Email      string `json:"email"`
	FeishuID   string `json:"feishu_id"`
	DingtalkID string `json:"dingtalk_id"`
	WecomID    string `json:"wecom_id"`
}

type personalProfileUpdate struct {
	Nickname   string  `json:"nickname"`
	AvatarURL  string  `json:"avatar_url"`
	Phone      string  `json:"phone"`
	Email      *string `json:"email"`
	FeishuID   *string `json:"feishu_id"`
	DingtalkID *string `json:"dingtalk_id"`
	WecomID    *string `json:"wecom_id"`
}

func profileWithContacts(nickname, avatarURL string, contact shared.NotificationProfile) personalProfile {
	return personalProfile{Nickname: nickname, AvatarURL: avatarURL, Phone: contact.Phone, Email: contact.Email, FeishuID: contact.FeishuID, DingtalkID: contact.DingtalkID, WecomID: contact.WecomID}
}

func validateAvatar(value string) error {
	if value == "" {
		return nil
	}
	// Store bounded image data with the profile; never execute SVG or fetch remote content.
	if len(value) > 350000 {
		return errors.New("头像不能超过 256 KB")
	}
	var expected string
	switch {
	case strings.HasPrefix(value, "data:image/png;base64,"):
		expected = "png"
	case strings.HasPrefix(value, "data:image/jpeg;base64,"):
		expected = "jpeg"
	default:
		return errors.New("头像仅支持 PNG 或 JPEG 图片")
	}
	raw, e := base64.StdEncoding.DecodeString(strings.SplitN(value, ",", 2)[1])
	if e != nil || len(raw) > 256*1024 {
		return errors.New("头像无效或超过 256 KB")
	}
	config, format, e := image.DecodeConfig(bytes.NewReader(raw))
	if e != nil || format != expected || config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
		return errors.New("请输入有效的 PNG 或 JPEG 头像，尺寸不超过 4096 像素")
	}
	return nil
}

func (a *Auth) registerProfile(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/auth/profile", func(w http.ResponseWriter, r *http.Request) {
		u := shared.CurrentUser(r)
		shared.JSON(w, 200, profileWithContacts(u.Nickname, u.AvatarURL, a.notificationProfile(u.ID)))
	})
	mux.HandleFunc("PUT /api/v1/auth/profile", func(w http.ResponseWriter, r *http.Request) {
		var p personalProfileUpdate
		if shared.Decode(r, &p) != nil {
			shared.Error(w, 400, "个人资料格式无效")
			return
		}
		p.Nickname = strings.TrimSpace(p.Nickname)
		if utf8.RuneCountInString(p.Nickname) > 40 || strings.IndexFunc(p.Nickname, unicode.IsControl) >= 0 {
			shared.Error(w, 400, "昵称最多 40 个字符，不能包含控制字符")
			return
		}
		if e := validateAvatar(p.AvatarURL); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		id := shared.CurrentUser(r).ID
		tx, e := a.DB.Begin()
		if e != nil {
			shared.Error(w, 500, "个人资料保存失败，请稍后重试")
			return
		}
		defer tx.Rollback()
		// Save display details and notification contacts in one transaction.
		contact := shared.NotificationProfile{UserID: id, Timezone: "Asia/Shanghai"}
		var raw string
		if e = tx.QueryRow("SELECT body FROM user_notification_profiles WHERE user_id=?", id).Scan(&raw); e == nil {
			if e = json.Unmarshal([]byte(raw), &contact); e != nil {
				shared.Error(w, 500, "联系方式读取失败")
				return
			}
		} else if !errors.Is(e, sql.ErrNoRows) {
			shared.Error(w, 500, "个人资料保存失败，请稍后重试")
			return
		}
		previousContact := contact
		contact.Phone = p.Phone
		// Older clients only send the phone; omitted contact fields retain their saved values.
		for _, field := range []struct {
			value  *string
			target *string
		}{{p.Email, &contact.Email}, {p.FeishuID, &contact.FeishuID}, {p.DingtalkID, &contact.DingtalkID}, {p.WecomID, &contact.WecomID}} {
			if field.value != nil {
				*field.target = *field.value
			}
		}
		if e = ValidateNotificationProfile(&contact); e != nil {
			shared.Error(w, 400, e.Error())
			return
		}
		if contact != previousContact {
			contact.Source = "manual"
			contact.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			_, e = tx.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body", id, encoded(contact))
			if e != nil {
				shared.Error(w, 500, "个人资料保存失败，请稍后重试")
				return
			}
		}
		_, e = tx.Exec("INSERT INTO user_profiles(user_id,nickname,avatar_url) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET nickname=excluded.nickname,avatar_url=excluded.avatar_url", id, p.Nickname, p.AvatarURL)
		if e == nil {
			e = tx.Commit()
		}
		if e != nil {
			shared.Error(w, 500, "个人资料保存失败，请稍后重试")
			return
		}
		shared.JSON(w, 200, profileWithContacts(p.Nickname, p.AvatarURL, contact))
	})
}
