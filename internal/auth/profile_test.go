package auth

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"net/http"
	"net/http/cookiejar"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestPersonalProfileLifecycleAndIsolation(t *testing.T) {
	a, s, admin := testAuth(t)
	status, owner := authRequest(t, admin, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatal(status, owner)
	}
	status, member := authRequest(t, admin, "POST", s.URL+"/api/v1/users", map[string]string{"name": "member", "role": "member", "password": "password123"})
	if status != 201 {
		t.Fatal(status, member)
	}
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}
	authRequest(t, client, "POST", s.URL+"/api/v1/auth/login", map[string]string{"name": "member", "password": "password123"})
	contact := shared.NotificationProfile{Email: "member@example.com", Phone: "13800000001", FeishuID: "ou_member", Timezone: "Asia/Shanghai"}
	status, result := authRequest(t, client, "PUT", s.URL+"/api/v1/auth/notification-profile", contact)
	if status != 200 {
		t.Fatal(status, result)
	}
	var encodedPNG bytes.Buffer
	if e := png.Encode(&encodedPNG, image.NewRGBA(image.Rect(0, 0, 2, 2))); e != nil {
		t.Fatal(e)
	}
	avatar := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encodedPNG.Bytes())
	input := map[string]string{"nickname": "  小明  ", "avatar_url": avatar, "phone": "13900000002", "role": "admin", "id": owner["id"].(string), "name": "changed"}
	status, result = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", input)
	if status != 200 || result["nickname"] != "小明" || result["phone"] != "+8613900000002" {
		t.Fatal(status, result)
	}
	status, me := authRequest(t, client, "GET", s.URL+"/api/v1/auth/me", nil)
	if status != 200 || me["id"] != member["id"] || me["role"] != "member" || me["name"] != "member" || me["nickname"] != "小明" || me["avatar_url"] != avatar {
		t.Fatal("profile changed identity or was not read back", status, me)
	}
	p := a.notificationProfile(member["id"].(string))
	if p.Phone != "+8613900000002" || p.Email != contact.Email || p.FeishuID != contact.FeishuID {
		t.Fatal("contact fields were lost", p)
	}
	_, adminProfile := authRequest(t, admin, "GET", s.URL+"/api/v1/auth/profile", nil)
	if adminProfile["nickname"] != "" || adminProfile["phone"] != "" {
		t.Fatal("member modified admin", adminProfile)
	}
	for _, endpoint := range []string{"/users", "/settings/login-providers"} {
		status, _ = authRequest(t, client, "GET", s.URL+"/api/v1"+endpoint, nil)
		if status != 403 {
			t.Fatal("member accessed admin endpoint", endpoint, status)
		}
	}
	// A later login must retain the display profile without changing the login name.
	authRequest(t, client, "POST", s.URL+"/api/v1/auth/logout", nil)
	status, result = authRequest(t, client, "POST", s.URL+"/api/v1/auth/login", map[string]string{"name": "member", "password": "password123"})
	if status != 200 || result["nickname"] != "小明" || result["avatar_url"] != avatar {
		t.Fatal(status, result)
	}
	// The alert contact editor and personal editor share the same phone.
	contact.Phone = "13700000003"
	authRequest(t, client, "PUT", s.URL+"/api/v1/auth/notification-profile", contact)
	_, result = authRequest(t, client, "GET", s.URL+"/api/v1/auth/profile", nil)
	if result["phone"] != "+8613700000003" {
		t.Fatal("phone is not shared", result)
	}
	// Invalid updates must preserve both stored profile and contact details.
	for _, invalid := range []map[string]string{
		{"nickname": strings.Repeat("明", 41)}, {"nickname": "bad\nname"}, {"phone": "bad"},
		{"avatar_url": "data:image/svg+xml;base64,PHN2Zy8+"}, {"avatar_url": "data:image/png;base64,YmFk"},
		{"avatar_url": "https://example.com/avatar.png"}, {"avatar_url": strings.Repeat("x", 350001)},
	} {
		status, result = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", invalid)
		if status != 400 {
			t.Fatal("invalid profile accepted", status, result)
		}
		_, result = authRequest(t, client, "GET", s.URL+"/api/v1/auth/profile", nil)
		if result["nickname"] != "小明" || result["phone"] != "+8613700000003" {
			t.Fatal("invalid update mutated profile", result)
		}
	}
	// Roll back the phone update when persisting the avatar/nickname fails.
	if _, e := a.DB.Exec("CREATE TRIGGER profile_failure BEFORE UPDATE ON user_profiles BEGIN SELECT RAISE(ABORT,'test failure'); END"); e != nil {
		t.Fatal(e)
	}
	status, _ = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", map[string]string{"nickname": "未保存", "phone": "13600000004"})
	if status != 500 {
		t.Fatal(status)
	}
	_, result = authRequest(t, client, "GET", s.URL+"/api/v1/auth/profile", nil)
	if result["nickname"] != "小明" || result["phone"] != "+8613700000003" {
		t.Fatal("failed update was not atomic", result)
	}
}

func TestPersonalProfileSavesAllAlertContactsAtomically(t *testing.T) {
	a, s, client := testAuth(t)
	status, actor := authRequest(t, client, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatal(status, actor)
	}
	contact := shared.NotificationProfile{UserID: actor["id"].(string), Phone: "+8613800000001", Email: "old@example.com", FeishuID: "ou_old", DingtalkID: "ding_old", WecomID: "wecom_old", Timezone: "Asia/Tokyo", Source: "sso:company", UpdatedAt: "2026-10-16T00:00:00Z"}
	if _, e := a.DB.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?)", contact.UserID, encoded(contact)); e != nil {
		t.Fatal(e)
	}
	_, initial := authRequest(t, client, "GET", s.URL+"/api/v1/auth/profile", nil)
	if initial["email"] != contact.Email || initial["feishu_id"] != contact.FeishuID || initial["dingtalk_id"] != contact.DingtalkID || initial["wecom_id"] != contact.WecomID {
		t.Fatal("profile omitted saved alert contacts", initial)
	}
	// Omitted fields from the older profile form must retain the existing contacts and SSO source.
	status, _ = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", map[string]string{"nickname": "管理员", "phone": contact.Phone})
	if status != 200 || a.notificationProfile(contact.UserID) != contact {
		t.Fatal("older profile update changed contacts", status, a.notificationProfile(contact.UserID))
	}
	input := map[string]string{"nickname": "值班管理员", "phone": "13900000002", "email": " new@example.com ", "feishu_id": "ou_new", "dingtalk_id": "ding_new", "wecom_id": "wecom_new"}
	status, saved := authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", input)
	if status != 200 || saved["email"] != "new@example.com" || saved["phone"] != "+8613900000002" || saved["feishu_id"] != input["feishu_id"] || saved["dingtalk_id"] != input["dingtalk_id"] || saved["wecom_id"] != input["wecom_id"] {
		t.Fatal("combined save failed", status, saved)
	}
	stored := a.notificationProfile(contact.UserID)
	if stored.Timezone != "Asia/Tokyo" || stored.Source != "manual" {
		t.Fatal("combined save lost notification metadata", stored)
	}
	// Invalid contact input must not partially save the nickname or any contact field.
	for _, invalid := range []map[string]string{{"nickname": "未保存", "phone": "13900000002", "email": "invalid"}, {"nickname": "未保存", "phone": "13900000002", "feishu_id": strings.Repeat("x", 257)}} {
		status, _ = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", invalid)
		if status != 400 || a.notificationProfile(contact.UserID) != stored {
			t.Fatal("invalid combined update changed contacts", status)
		}
		_, profile := authRequest(t, client, "GET", s.URL+"/api/v1/auth/profile", nil)
		if profile["nickname"] != saved["nickname"] {
			t.Fatal("invalid contact update changed nickname", profile)
		}
	}
	// Explicit empty values clear the selected contact while omitted fields stay intact.
	status, cleared := authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", map[string]string{"nickname": "值班管理员", "phone": "+8613900000002", "email": ""})
	if status != 200 || cleared["email"] != "" || cleared["feishu_id"] != "ou_new" || cleared["dingtalk_id"] != "ding_new" || cleared["wecom_id"] != "wecom_new" {
		t.Fatal("explicit clear lost unrelated contacts", status, cleared)
	}
	stored = a.notificationProfile(contact.UserID)
	if _, e := a.DB.Exec("CREATE TRIGGER profile_contacts_failure BEFORE UPDATE ON user_profiles BEGIN SELECT RAISE(ABORT,'test failure'); END"); e != nil {
		t.Fatal(e)
	}
	status, _ = authRequest(t, client, "PUT", s.URL+"/api/v1/auth/profile", input)
	if status != 500 || a.notificationProfile(contact.UserID) != stored {
		t.Fatal("failed combined update did not roll back contacts", status)
	}
}
