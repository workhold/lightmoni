package alerts

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func phoneConfig(typ, endpoint string) map[string]string {
	return map[string]string{"endpoint": endpoint, "access_key_id": "ALI-ID", "access_key_secret": "ALI-SECRET",
		"secret_id": "TENCENT-ID", "secret_key": "TENCENT-SECRET", "sdk_app_id": "1400000000", "region": "ap-guangzhou",
		"app_key": "HUAWEI-ID", "app_secret": "HUAWEI-SECRET", "sender": "106900000000", "sign_name": "监控",
		"template_code": "TTS_TEST", "template_id": "123", "template_params": map[bool]string{true: `{"name":"{{rule}}"}`, false: `["{{rule}}","{{status}}","{{value}}"]`}[typ == "aliyun_voice"], "play_times": "2"}
}

func TestPhoneProviderRequests(t *testing.T) {
	for _, typ := range []string{"aliyun_voice", "tencent_sms", "tencent_voice", "huawei_sms"} {
		t.Run(typ, func(t *testing.T) {
			m, _ := testModule(t)
			now := time.Date(2026, 10, 12, 0, 30, 0, 0, time.UTC)
			m.now = func() time.Time { return now }
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost {
					t.Error("provider requires POST")
				}
				switch typ {
				case "aliyun_voice":
					_ = r.ParseForm()
					params := map[string]string{}
					for key := range r.Form {
						if key != "Signature" {
							params[key] = r.Form.Get(key)
						}
					}
					if r.Form.Get("Signature") != smsSignature(params, "ALI-SECRET") || r.Form.Get("Action") != "SingleCallByTts" || r.Form.Get("CalledNumber") != "13800000000" || r.Form.Get("TtsParam") != `{"name":"CPU"}` || r.Form.Get("PlayTimes") != "2" {
						t.Error("invalid Aliyun voice request", r.Form)
					}
					_, _ = io.WriteString(w, `{"Code":"OK","CallId":"voice-ali"}`)
				case "tencent_sms", "tencent_voice":
					raw, _ := io.ReadAll(r.Body)
					var payload map[string]any
					_ = json.Unmarshal(raw, &payload)
					service, action, version := "sms", "SendSms", "2021-01-11"
					response := `{"Response":{"SendStatusSet":[{"Code":"Ok","SerialNo":"sms-tencent"}]}}`
					if typ == "tencent_voice" {
						service, action, version = "vms", "SendTtsVoice", "2020-09-02"
						response = `{"Response":{"SendStatus":{"CallId":"voice-tencent"}}}`
						if payload["CalledNumber"] != "+8613800000000" || payload["VoiceSdkAppid"] != "1400000000" || payload["PlayTimes"] != float64(2) {
							t.Error("invalid voice params", payload)
						}
					} else if payload["SmsSdkAppId"] != "1400000000" || !reflect.DeepEqual(payload["PhoneNumberSet"], []any{"+8613800000000"}) {
						t.Error("invalid SMS params", payload)
					}
					if r.Header.Get("Authorization") != tencentAuthorization("TENCENT-ID", "TENCENT-SECRET", service, r.Host, raw, now) || r.Header.Get("X-TC-Action") != action || r.Header.Get("X-TC-Version") != version || r.Header.Get("X-TC-Region") != "ap-guangzhou" {
						t.Error("invalid Tencent authentication")
					}
					if !reflect.DeepEqual(payload["TemplateParamSet"], []any{"CPU", "firing", "95"}) || payload["SessionContext"] != "delivery-id" {
						t.Error("invalid template params", payload)
					}
					_, _ = io.WriteString(w, response)
				case "huawei_sms":
					_ = r.ParseForm()
					values := regexp.MustCompile(`(Username|PasswordDigest|Nonce|Created)="([^"]+)"`).FindAllStringSubmatch(r.Header.Get("X-WSSE"), -1)
					auth := map[string]string{}
					for _, value := range values {
						auth[value[1]] = value[2]
					}
					sum := sha256.Sum256([]byte(auth["Nonce"] + auth["Created"] + "HUAWEI-SECRET"))
					digest := base64.StdEncoding.EncodeToString([]byte(hex.EncodeToString(sum[:])))
					if r.URL.Path != "/sms/batchSendSms/v1" || auth["Username"] != "HUAWEI-ID" || auth["PasswordDigest"] != digest || auth["Created"] != "2026-10-12T00:30:00Z" || r.Header.Get("Authorization") != `WSSE realm="SDP",profile="UsernameToken",type="Appkey"` {
						t.Error("invalid Huawei authentication", auth)
					}
					if r.Form.Get("to") != "+8613800000000" || r.Form.Get("from") != "106900000000" || r.Form.Get("templateParas") != `["CPU","firing","95"]` {
						t.Error("invalid Huawei params", r.Form)
					}
					_, _ = io.WriteString(w, `{"code":"000000","result":[{"status":"000000","smsMsgId":"sms-huawei"}]}`)
				}
			}))
			defer server.Close()
			d := Delivery{ID: "delivery-id", Recipient: Recipient{Kind: "phone", Value: "13800000000"}, Payload: Event{RuleName: "CPU", Kind: "firing", State: State{Value: "95"}}}
			result := m.send(context.Background(), Channel{Type: typ, Config: phoneConfig(typ, server.URL)}, d)
			if result.Status != "accepted" || result.ProviderID == "" {
				t.Fatal(result)
			}
		})
	}
}

func TestTencentSigningVector(t *testing.T) {
	body := []byte(`{"TemplateId":"123","TemplateParamSet":["CPU"],"CalledNumber":"+8613800000000","VoiceSdkAppid":"1400000000"}`)
	// Independent Python hashlib/hmac vector, with the UTC date crossing midnight in Asia/Shanghai.
	now := time.Unix(1791757800, 0).In(time.FixedZone("Asia/Shanghai", 8*3600))
	got := tencentAuthorization("test-id", "test-secret", "vms", "vms.tencentcloudapi.com", body, now)
	want := "TC3-HMAC-SHA256 Credential=test-id/2026-10-11/vms/tc3_request, SignedHeaders=content-type;host, Signature=8b4a0ca7003540f7f28a681fe49b384ba098db228b7ce1101cb811d94937d076"
	if got != want {
		t.Fatalf("signature mismatch\n%s", got)
	}
}

func TestPhoneBusinessFailuresAndUnknown(t *testing.T) {
	cases := []struct {
		typ, body, status string
		retry             bool
	}{
		{"aliyun_voice", `{"Code":"isv.TTS_TEMPLATE_NOT_EXIST"}`, "failed", false},
		{"aliyun_voice", `{"Code":"isv.BUSINESS_LIMIT_CONTROL"}`, "failed", true},
		{"tencent_sms", `{"Response":{"SendStatusSet":[{"Code":"FailedOperation.TemplateParamSetNotMatchApprovedTemplate"}]}}`, "failed", false},
		{"tencent_voice", `{"Response":{"Error":{"Code":"AuthFailure.SignatureFailure"}}}`, "failed", false},
		{"tencent_sms", `{"Response":{"Error":{"Code":"InternalError.SendAndRecvFail"}}}`, "unknown", false},
		{"tencent_sms", `{"Response":{"Error":{"Code":"RequestLimitExceeded"}}}`, "failed", true},
		{"tencent_voice", `{"Response":{}}`, "unknown", false},
		{"huawei_sms", `{"code":"000000","result":[{"status":"E200015"}]}`, "failed", false},
		{"huawei_sms", `{"code":"E000102"}`, "failed", false},
	}
	for _, tc := range cases {
		t.Run(tc.typ+tc.body, func(t *testing.T) {
			m, _ := testModule(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, tc.body) }))
			defer server.Close()
			result := m.send(context.Background(), Channel{Type: tc.typ, Config: phoneConfig(tc.typ, server.URL)}, Delivery{Recipient: Recipient{Kind: "phone", Value: "13800000000"}})
			if result.Status != tc.status || result.Retryable != tc.retry {
				t.Fatal(result)
			}
		})
	}
	for _, typ := range []string{"aliyun_voice", "tencent_sms", "tencent_voice", "huawei_sms"} {
		for _, scenario := range []string{"lost-response", "invalid-json", "server-error", "rate-limit"} {
			t.Run(typ+scenario, func(t *testing.T) {
				m, mux := testModule(t)
				var calls atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					if scenario == "lost-response" {
						conn, _, _ := w.(http.Hijacker).Hijack()
						_ = conn.Close()
						return
					}
					if scenario == "server-error" {
						w.WriteHeader(503)
					}
					if scenario == "rate-limit" {
						w.Header().Set("Retry-After", "30")
						w.WriteHeader(429)
					}
					_, _ = io.WriteString(w, "invalid")
				}))
				defer server.Close()
				var c Channel
				_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "test", Type: typ, Enabled: true, Config: phoneConfig(typ, server.URL)}, 200), &c)
				request(t, mux, "POST", "/api/v1/notify/channels/"+c.ID+"/test", map[string]any{"recipient": Recipient{Kind: "phone", Value: "13800000000"}}, 200)
				if e := m.SendPending(context.Background()); e != nil {
					t.Fatal(e)
				}
				var deliveries []Delivery
				_ = json.Unmarshal(request(t, mux, "GET", "/api/v1/notify/deliveries", nil, 200), &deliveries)
				want := "unknown"
				if scenario == "rate-limit" {
					want = "retry"
				}
				if len(deliveries) != 1 || deliveries[0].Status != want {
					t.Fatal(deliveries)
				}
				if e := m.SendPending(context.Background()); e != nil {
					t.Fatal(e)
				}
				if calls.Load() != 1 {
					t.Fatal("ambiguous submissions must not repeat", calls.Load())
				}
			})
		}
	}
}

func TestPhoneConfigurationAndSecretLifecycle(t *testing.T) {
	for _, typ := range []string{"aliyun_voice", "tencent_sms", "tencent_voice", "huawei_sms"} {
		t.Run(typ, func(t *testing.T) {
			m, mux := testModule(t)
			var c Channel
			_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "new", Type: typ, Enabled: true, Config: phoneConfig(typ, "http://localhost:1234")}, 200), &c)
			for key := range secretFields {
				if c.Config[key] != "" {
					t.Fatal("secret leaked", key)
				}
			}
			request(t, mux, "PUT", "/api/v1/notify/channels/"+c.ID, c, 200)
			saved, e := m.channel(context.Background(), c.ID, true)
			if e != nil || saved.Config["secret_key"] != "TENCENT-SECRET" || saved.Config["app_secret"] != "HUAWEI-SECRET" {
				t.Fatal("secrets were not preserved", e)
			}
			request(t, mux, "POST", "/api/v1/alerts/groups", Group{Name: "phone", Enabled: true, Targets: []Target{{ChannelID: c.ID, Recipient: Recipient{Kind: "email", Value: "ops@example.com"}}}}, 400)
			raw := request(t, mux, "POST", "/api/v1/alerts/groups", Group{Name: "phone", Enabled: true, Targets: []Target{{ChannelID: c.ID, Recipient: Recipient{Kind: "phone", Value: "13800000000"}}}}, 200)
			var group Group
			_ = json.Unmarshal(raw, &group)
			want := "+8613800000000"
			if typ == "aliyun_voice" {
				want = "13800000000"
			}
			if group.Targets[0].Recipient.Value != want {
				t.Fatal(group)
			}
			request(t, mux, "POST", "/api/v1/notify/channels/"+c.ID+"/test", map[string]any{"recipient": group.Targets[0].Recipient}, 200)
			saved.Config["template_params"] = map[bool]string{true: `{"changed":"{{status}}"}`, false: `["{{status}}"]`}[typ == "aliyun_voice"]
			request(t, mux, "PUT", "/api/v1/notify/channels/"+c.ID, saved, 200)
			var ds []Delivery
			_ = json.Unmarshal(request(t, mux, "GET", "/api/v1/notify/deliveries", nil, 200), &ds)
			if len(ds) != 1 || ds[0].Status != "cancelled" {
				t.Fatal("changed template must cancel queued jobs", ds)
			}
		})
	}
	for _, raw := range []string{`null`, `{"name":1}`, `[1]`, `not json`} {
		if validateTemplateParams(raw, true) == nil || validateTemplateParams(raw, false) == nil {
			t.Fatal("invalid params accepted", raw)
		}
	}
	for _, value := range []string{"13800000000", "+8613800000000", "8613800000000", "008613800000000"} {
		p := Recipient{Kind: "phone", Value: value}
		if validateRecipient("tencent_voice", &p) != nil || p.Value != "+8613800000000" {
			t.Fatal(p)
		}
	}
	for _, value := range []string{"13800000000,13900000000", "+00000000000", "abcdefghijk", "+1234567890123456"} {
		p := Recipient{Kind: "phone", Value: value}
		if validateRecipient("tencent_sms", &p) == nil {
			t.Fatal("invalid phone accepted", value)
		}
	}
	config := phoneConfig("tencent_voice", "http://localhost")
	for _, key := range []string{"secret_id", "secret_key", "sdk_app_id", "template_id"} {
		old := config[key]
		config[key] = ""
		if validateChannel("tencent_voice", config) == nil {
			t.Fatal("missing field accepted", key)
		}
		config[key] = old
	}
	config["play_times"] = "4"
	if validateChannel("tencent_voice", config) == nil {
		t.Fatal("invalid playback count accepted")
	}
	config["play_times"] = "2"
	config["endpoint"] = "https://vms.tencentcloudapi.com/path"
	if validateChannel("tencent_voice", config) == nil {
		t.Fatal("invalid signing path accepted")
	}
	if rateKey(Channel{Type: "tencent_sms", Config: map[string]string{"secret_id": "a"}}) == rateKey(Channel{Type: "tencent_sms", Config: map[string]string{"secret_id": "b"}}) {
		t.Fatal("different provider accounts share a rate key")
	}
}

func TestSMTPLoginAndDisplaySender(t *testing.T) {
	m, _ := testModule(t)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			done <- e
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
		reader := bufio.NewReader(conn)
		reply := func(value string) { _, _ = fmt.Fprint(conn, value+"\r\n") }
		reply("220 local")
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				done <- e
				return
			}
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "EHLO"):
				reply("250-local")
				reply("250 AUTH LOGIN")
			case line == "AUTH LOGIN":
				reply("334 VXNlcm5hbWU6")
			case line == base64.StdEncoding.EncodeToString([]byte("user@example.com")):
				reply("334 UGFzc3dvcmQ6")
			case line == base64.StdEncoding.EncodeToString([]byte("authorization-code")):
				reply("235 authenticated")
			case line == "MAIL FROM:<alerts@example.com>":
				reply("250 ok")
			case line == "RCPT TO:<ops@example.com>":
				reply("250 ok")
			case line == "DATA":
				reply("354 go")
				for {
					line, e = reader.ReadString('\n')
					if e != nil {
						done <- e
						return
					}
					if line == ".\r\n" {
						break
					}
				}
				reply("250 accepted")
			case line == "QUIT":
				reply("221 bye")
				done <- nil
				return
			default:
				reply("500 unexpected command")
				done <- fmt.Errorf("unexpected SMTP command %q", line)
				return
			}
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	result := m.send(context.Background(), Channel{Type: "smtp", Config: map[string]string{"host": host, "port": port, "tls": "none", "username": "user@example.com", "password": "authorization-code", "from": "LightMoni <alerts@example.com>"}}, Delivery{ID: "test", Recipient: Recipient{Kind: "email", Value: "ops@example.com"}, Payload: Event{RuleName: "CPU", Message: "test"}})
	if result.Status != "accepted" {
		t.Fatal(result)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	auth := &smtpLoginAuth{host: "smtp.qq.com"}
	if _, _, e = auth.Start(&smtp.ServerInfo{Name: "smtp.qq.com"}); e == nil {
		t.Fatal("remote LOGIN must require TLS")
	}
}
