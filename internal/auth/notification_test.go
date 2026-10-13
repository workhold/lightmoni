package auth

import (
	"net/http"
	"net/http/cookiejar"
	"testing"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestNotificationProfilesSSOMappingAndUserIsolation(t *testing.T) {
	a, s, c := testAuth(t)
	status, admin := authRequest(t, c, "POST", s.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatal(status, admin)
	}
	status, member := authRequest(t, c, "POST", s.URL+"/api/v1/users", map[string]any{"name": "member", "password": "password123", "role": "member"})
	if status != 201 {
		t.Fatal(status, member)
	}
	uid := member["id"].(string)
	p := Provider{ID: "sso", EmailField: "contact.mail", PhoneField: "contact.mobile", FeishuIDField: "open_id", DingtalkIDField: "staff", WecomIDField: "staff"}
	if e := a.syncNotificationProfile(uid, p, map[string]any{"contact": map[string]any{"mail": "sso@example.com", "mobile": "13800000001"}, "open_id": "ou_user", "staff": "staff1"}); e != nil {
		t.Fatal(e)
	}
	profile := a.notificationProfile(uid)
	if profile.Phone != "+8613800000001" || profile.Email != "sso@example.com" || profile.Source != "sso:sso" || profile.WecomID != "staff1" {
		t.Fatal("SSO fields not mapped", profile)
	}
	jar, _ := cookiejar.New(nil)
	mc := &http.Client{Jar: jar}
	status, _ = authRequest(t, mc, "POST", s.URL+"/api/v1/auth/login", map[string]string{"name": "member", "password": "password123"})
	if status != 200 {
		t.Fatal(status)
	}
	status, _ = authRequest(t, mc, "GET", s.URL+"/api/v1/users/"+admin["id"].(string)+"/notification-profile", nil)
	if status != 403 {
		t.Fatal("member could read admin contact", status)
	}
	status, _ = authRequest(t, mc, "PUT", s.URL+"/api/v1/users/"+admin["id"].(string)+"/notification-profile", shared.NotificationProfile{Email: "hijack@example.com"})
	if status != 403 {
		t.Fatal("member could modify admin contact", status)
	}
	status, _ = authRequest(t, mc, "PUT", s.URL+"/api/v1/auth/notification-profile", shared.NotificationProfile{Email: "manual@example.com", Phone: "13900000001"})
	if status != 200 {
		t.Fatal(status)
	}
	if e := a.syncNotificationProfile(uid, p, map[string]any{"contact": map[string]any{"mail": "new-sso@example.com", "mobile": "13800000002"}}); e != nil {
		t.Fatal(e)
	}
	if profile = a.notificationProfile(uid); profile.Email != "manual@example.com" || profile.Phone != "+8613900000001" || profile.Source != "manual" {
		t.Fatal("SSO replaced manual contact", profile)
	}
	status, _ = authRequest(t, mc, "PUT", s.URL+"/api/v1/auth/notification-profile", shared.NotificationProfile{Phone: "bad"})
	if status != 400 || a.notificationProfile(uid).Phone != "+8613900000001" {
		t.Fatal("invalid profile changed saved contact", status)
	}
}

func TestAlertLoginReturnTargetsRemainLocal(t *testing.T) {
	for _, target := range []string{"/alerts?claim=abc", "/a/abc", "/traces/trace-1?from=x", "/"} {
		if !safeReturnTarget(target) {
			t.Fatal("valid local return rejected", target)
		}
	}
	for _, target := range []string{"https://elsewhere.example/alerts", "//elsewhere.example/alerts", "/\\elsewhere.example/alerts", "/alerts\r\nLocation: https://elsewhere.example", "/settings", "/alertsevil"} {
		if safeReturnTarget(target) {
			t.Fatal("unsafe or unrelated return accepted", target)
		}
	}
}
