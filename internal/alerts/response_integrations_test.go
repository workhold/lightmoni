package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestFeishuApplicationSendAndNativeCardClaim(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/open-apis/auth/v3/tenant_access_token/internal":
			w.Write([]byte(`{"code":0,"tenant_access_token":"local-token"}`))
		case "/open-apis/im/v1/messages":
			var v struct {
				ReceiveID string `json:"receive_id"`
				Content   string `json:"content"`
			}
			_ = json.NewDecoder(r.Body).Decode(&v)
			if v.ReceiveID != "open_u1" || r.Header.Get("Authorization") != "Bearer local-token" {
				t.Errorf("wrong Feishu request %+v", v)
			}
			if strings.Contains(v.Content, "已恢复") {
				if strings.Contains(v.Content, "response_id") {
					t.Error("recovery message has a stale claim action")
				}
			} else if !strings.Contains(v.Content, "response_id") {
				t.Error("open alert is missing the native claim action")
			}
			w.Write([]byte(`{"code":0,"data":{"message_id":"message-test"}}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer receiver.Close()
	m, mux, rule, g, now := managedFixture(t, receiver.URL)
	var c Channel
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "app", Type: "feishu_app", Enabled: true, Config: map[string]string{"app_id": "test-app", "app_secret": "test-secret", "verification_token": "verify", "api_base": receiver.URL}}, 200), &c)
	g.ChannelIDs = []string{c.ID}
	g.Primary = []string{"u1"}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"chat"}, RepeatSeconds: 60, MaxRounds: 3}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	r := responseRows(t, m)[0]
	c, _ = m.channel(context.Background(), c.ID, true)
	pub := http.NewServeMux()
	m.RegisterPublic(pub)
	path := "/api/v1/notify/callbacks/" + c.ID + "/" + c.Config["callback_token"]
	request(t, pub, "POST", path, map[string]string{"token": "verify", "challenge": "test-challenge"}, 200)
	*now = now.Add(12 * time.Second)
	body := map[string]any{"header": map[string]string{"token": "verify", "app_id": "test-app"}, "event": map[string]any{"operator": map[string]string{"open_id": "open_u1"}, "action": map[string]any{"value": map[string]string{"action": "ack", "response_id": r.ID}}}}
	request(t, pub, "POST", path, body, 200)
	r = responseRows(t, m)[0]
	if r.OwnerID != "u1" || r.AckMethod != "feishu_card" {
		t.Fatalf("card failed to claim %+v", r)
	}
	if result := m.send(context.Background(), c, Delivery{ID: "recovered", ResponseID: r.ID, UserID: "u1", Recipient: Recipient{Kind: "feishu_user", Value: "open_u1"}, Payload: Event{Kind: "resolved", Message: "已恢复"}}); result.Status != "accepted" {
		t.Fatal("recovery card not sent", result)
	}
	request(t, pub, "POST", path, map[string]string{"token": "wrong", "challenge": "bad"}, 403)
	listed := request(t, mux, "GET", "/api/v1/notify/channels", nil, 200)
	if strings.Contains(string(listed), "test-secret") || strings.Contains(string(listed), "callback_token") || strings.Contains(string(listed), "verify\"") {
		t.Fatal("application secrets exposed")
	}
}

func TestEvidenceIsBoundedParameterizedAndDoesNotChangeClaim(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, _, now := managedFixture(t, receiver.URL)
	originalCatalog := m.deps.Catalog
	m.deps.Catalog = func(ctx context.Context) ([]shared.Table, error) {
		tables, e := originalCatalog(ctx)
		for i := range tables {
			if tables[i].ID == "log_app" {
				tables[i].Kind = "log"
				tables[i].Services = []string{"api"}
				for _, name := range []string{"event_id", "event_time", "service", "severity", "body", "trace_id"} {
					tables[i].Columns = append(tables[i].Columns, shared.Column{Name: name, Type: "String"})
				}
			}
		}
		return append(tables, shared.Table{ID: "trace_app", Name: "trace_app", Kind: "trace", Services: []string{"api"}, Columns: []shared.Column{{Name: "event_time", Type: "DateTime64"}, {Name: "span_id", Type: "String"}, {Name: "parent_span_id", Type: "String"}, {Name: "start_time", Type: "DateTime64"}, {Name: "end_time", Type: "DateTime64"}, {Name: "trace_id", Type: "String"}}}), e
	}
	rule.Services = []string{"api"}
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	if rule.EvidenceProfile == nil || rule.EvidenceProfile.LogTableID != "log_app" || len(rule.EvidenceProfile.TraceTableIDs) != 1 {
		t.Fatalf("unambiguous context not inferred %+v", rule.EvidenceProfile)
	}
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	r := responseRows(t, m)[0]
	memberRequest(t, mux, "u1", "/api/v1/alerts/incidents/"+r.ID+"/ack", nil, 200)
	m.deps.Query = func(ctx context.Context, q shared.QueryRequest) (shared.QueryResponse, error) {
		if q.Queries[0].RefID == "evidence" {
			if !strings.Contains(q.Queries[0].SQL, "LIMIT 11") || q.Queries[0].Params["label_0"].Value != "api" {
				t.Errorf("unbounded/unbound context %+v", q)
			}
			return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "event_id"}, {Name: "body"}, {Name: "trace_id"}}, Rows: [][]any{{"log1", "password=secret error", "trace-1"}}}}}}}, nil
		}
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "span_id"}, {Name: "parent_span_id"}, {Name: "trace_id"}}, Rows: [][]any{{"child", "missing", "trace-1"}}}}}}}, nil
	}
	if e := m.CollectPendingEvidence(context.Background()); e != nil {
		t.Fatal(e)
	}
	r = responseRows(t, m)[0]
	if r.State != "acknowledged" || len(r.Evidence.Logs) != 1 || strings.Contains(encode(r.Evidence), "password=secret") {
		t.Fatalf("evidence lost claim or leaked data %+v", r)
	}
	var trace struct {
		Incomplete bool `json:"incomplete"`
		Missing    int  `json:"missing_parents"`
	}
	path := "/api/v1/traces/trace-1?tables=trace_app&from=" + r.Event.Range.From + "&to=" + r.Event.Range.To
	_ = json.Unmarshal(request(t, mux, "GET", path, nil, 200), &trace)
	if !trace.Incomplete || trace.Missing != 1 {
		t.Fatalf("missing spans fabricated %+v", trace)
	}
}

func TestDirectoryFailureRetainsMembersAndManualContacts(t *testing.T) {
	broken := false
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if broken {
			w.WriteHeader(500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"members": []map[string]any{{"user_id": "u1", "profile": shared.NotificationProfile{Email: "directory@example.com"}}, {"user_id": "u2", "profile": shared.NotificationProfile{Phone: "13800000002"}}, {"user_id": "u3", "profile": shared.NotificationProfile{}}, {"user_id": "u4", "profile": shared.NotificationProfile{}}}})
	}))
	defer receiver.Close()
	m, mux, _, g, _ := managedFixture(t, receiver.URL)
	p := shared.NotificationProfile{UserID: "u1", Email: "manual@example.com", Source: "manual"}
	_, _ = m.deps.DB.Exec("UPDATE user_notification_profiles SET body=? WHERE user_id='u1'", encode(p))
	s := DirectorySource{ID: "source", Name: "Directory", URL: receiver.URL, GroupID: g.ID, Enabled: true, IntervalSeconds: 60}
	request(t, mux, "PUT", "/api/v1/settings/alert-directory-sources/source", s, 200)
	request(t, mux, "POST", "/api/v1/settings/alert-directory-sources/source/sync", nil, 200)
	_, saved, _ := m.member(context.Background(), "u1")
	if saved.Email != "manual@example.com" {
		t.Fatal("directory overwrote a manual contact")
	}
	_, saved, _ = m.member(context.Background(), "u2")
	if saved.Phone != "+8613800000002" {
		t.Fatalf("directory phone not normalized %+v", saved)
	}
	broken = true
	request(t, mux, "POST", "/api/v1/settings/alert-directory-sources/source/sync", nil, 502)
	after, _ := m.group(context.Background(), g.ID)
	if len(after.Members) != 4 {
		t.Fatal("failed directory cleared members")
	}
}

func TestStageRoundLimitStillReachesBackupAndFallback(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, g, now := managedFixture(t, receiver.URL)
	p := g.Policies["P0"]
	p.MaxRounds = 1
	g.Policies["P0"] = p
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	*now = now.Add(10 * time.Second)
	tickSend(t, m)
	if responseRows(t, m)[0].Exhausted {
		t.Fatal("primary round cap stopped future backup")
	}
	*now = now.Add(10 * time.Second)
	tickSend(t, m)
	if responseRows(t, m)[0].Stage != "backup" {
		t.Fatal("backup was skipped")
	}
	*now = now.Add(20 * time.Second)
	tickSend(t, m)
	r := responseRows(t, m)[0]
	if r.Stage != "fallback" || r.Round != 3 {
		t.Fatalf("fallback or repeat budget wrong %+v", r)
	}
}
