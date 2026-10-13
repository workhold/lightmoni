package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func managedFixture(t *testing.T, endpoint string) (*Module, *http.ServeMux, Rule, Group, *time.Time) {
	t.Helper()
	m, mux := testModule(t)
	if _, e := m.deps.DB.Exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,active INTEGER NOT NULL)"); e != nil {
		t.Fatal(e)
	}
	for _, u := range []string{"u1", "u2", "u3", "u4"} {
		if _, e := m.deps.DB.Exec("INSERT INTO users(id,name,active) VALUES(?,?,1)", u, u); e != nil {
			t.Fatal(e)
		}
		p := shared.NotificationProfile{UserID: u, Email: u + "@example.com", Phone: "+861380000000" + u[1:], FeishuID: "open_" + u, Timezone: "Asia/Shanghai"}
		if _, e := m.deps.DB.Exec("INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?)", u, encode(p)); e != nil {
			t.Fatal(e)
		}
	}
	r := seed(t, m, mux, endpoint)
	g, _ := m.group(context.Background(), "group-a")
	g.Members = []string{"u1", "u2", "u3", "u4"}
	g.Primary = []string{"u1", "u2"}
	g.Backup = []string{"u3"}
	g.Fallback = []string{"u4"}
	g.ChannelIDs = []string{g.Targets[0].ChannelID}
	g.Timezone = "Asia/Shanghai"
	g.Policies = defaultPolicies()
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"webhook"}, RepeatSeconds: 10, BackupAfterSeconds: 20, FallbackAfterSeconds: 40, MaxRounds: 8, HandlingSeconds: 300}
	var saved Group
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/groups/group-a", g, 200), &saved)
	g = saved
	r.GroupIDs = []string{g.ID}
	r.ForSeconds = 0
	r.Severity = "P0"
	r.RecoverySeconds = 0
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	return m, mux, r, g, &now
}
func responseRows(t *testing.T, m *Module) []IncidentResponse {
	t.Helper()
	rs, e := listBodies[IncidentResponse](context.Background(), m.deps.DB, "SELECT body FROM alert_responses ORDER BY created_at")
	if e != nil {
		t.Fatal(e)
	}
	return rs
}
func tickSend(t *testing.T, m *Module) {
	t.Helper()
	if e := m.TickResponses(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
}
func memberRequest(t *testing.T, mux *http.ServeMux, user, path string, body any, status int) []byte {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(encode(body)))
	req = req.WithContext(shared.WithUser(req.Context(), shared.User{ID: user, Role: "member"}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != status {
		t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

func TestResponsePrimaryBackupClaimAndStatistics(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(202) }))
	defer receiver.Close()
	m, mux, rule, _, now := managedFixture(t, receiver.URL)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	rs := responseRows(t, m)
	if len(rs) != 1 || rs[0].Round != 1 || rs[0].Stage != "primary" {
		t.Fatalf("%+v", rs)
	}
	*now = now.Add(10 * time.Second)
	tickSend(t, m)
	*now = now.Add(10 * time.Second)
	tickSend(t, m)
	r := responseRows(t, m)[0]
	if r.Stage != "backup" {
		t.Fatalf("expected backup, %+v", r)
	}
	*now = now.Add(5 * time.Second)
	memberRequest(t, mux, "u3", "/api/v1/alerts/incidents/"+r.ID+"/ack", nil, 200)
	*now = now.Add(60 * time.Second)
	tickSend(t, m)
	r = responseRows(t, m)[0]
	if r.State != "acknowledged" || r.OwnerID != "u3" || r.AckMethod != "web" {
		t.Fatalf("%+v", r)
	}
	var stats struct {
		Users []UserResponseStatistics `json:"users"`
	}
	_ = json.Unmarshal(request(t, mux, "GET", "/api/v1/alerts/response-statistics", nil, 200), &stats)
	if len(stats.Users) != 4 {
		t.Fatalf("stats %+v", stats.Users)
	}
	for _, u := range stats.Users {
		if u.UserID == "u4" {
			if u.Notified != 0 {
				t.Fatal("unnotified user was counted")
			}
			continue
		}
		if u.Notified != 1 {
			t.Fatalf("repeat counted twice: %+v", u)
		}
		if u.UserID == "u3" && (u.Acknowledged != 1 || u.MeanAckSeconds != 5 || u.AckRate != 100) {
			t.Fatalf("wrong claim metrics %+v", u)
		}
		if u.UserID != "u3" && u.PeerClaimed != 1 {
			t.Fatalf("peer claim not recorded %+v", u)
		}
	}
}

func TestResponseConcurrentClaimsAndAuthenticatedLink(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, _, now := managedFixture(t, receiver.URL)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	r := responseRows(t, m)[0]
	ds, _ := listBodies[Delivery](context.Background(), m.deps.DB, "SELECT body FROM alert_outbox WHERE json_extract(body,'$.response_id')=?", r.ID)
	u, _ := url.Parse(ds[0].AckURL)
	token := strings.TrimPrefix(u.Path, "/a/")
	req := httptest.NewRequest("GET", "/api/v1/alerts/claim?token="+token, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 405 {
		t.Fatalf("GET claim allowed %d", w.Code)
	}
	if got := responseRows(t, m)[0].State; got != "unclaimed" {
		t.Fatalf("GET changed response %s", got)
	}
	memberRequest(t, mux, "not-a-member", "/api/v1/alerts/claim", map[string]string{"token": token}, 409)
	var wg sync.WaitGroup
	success := make(chan string, 2)
	for _, user := range []string{"u1", "u2"} {
		wg.Add(1)
		go func(user string) {
			defer wg.Done()
			if _, e := m.acknowledge(context.Background(), r.ID, user, "chat_link", *now); e == nil {
				success <- user
			}
		}(user)
	}
	wg.Wait()
	close(success)
	count := 0
	for range success {
		count++
	}
	if count != 1 {
		t.Fatalf("%d concurrent owners", count)
	}
	r = responseRows(t, m)[0]
	memberRequest(t, mux, r.OwnerID, "/api/v1/alerts/claim", map[string]string{"token": token}, 200)
	var n int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_response_events WHERE response_id=? AND json_extract(body,'$.kind')='acknowledged'", r.ID).Scan(&n)
	if n != 1 {
		t.Fatalf("duplicate claim event %d", n)
	}
}

func TestResponseNightWindowAndPriorityEscalation(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, g, now := managedFixture(t, receiver.URL)
	g.Policies["P2"] = PriorityPolicy{Methods: []string{"webhook"}, Start: "09:00", End: "22:00", RepeatSeconds: 60, EscalateAfterRounds: 3, EscalateTo: "P1", MaxRounds: 8}
	g.Policies["P1"] = PriorityPolicy{Methods: []string{"webhook"}, Start: "09:00", End: "22:00", RepeatSeconds: 60, BackupAfterSeconds: 120, MaxRounds: 8}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	rule.Severity = "P2"
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	*now = time.Date(2026, 10, 12, 13, 59, 30, 0, time.UTC)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	*now = now.Add(30 * time.Second)
	tickSend(t, m)
	*now = time.Date(2026, 10, 13, 0, 59, 0, 0, time.UTC)
	tickSend(t, m)
	r := responseRows(t, m)[0]
	if r.Priority != "P2" || r.Round != 1 || r.ActiveSeconds != 30 {
		t.Fatalf("night escalated: %+v", r)
	}
	*now = time.Date(2026, 10, 13, 1, 0, 0, 0, time.UTC)
	tickSend(t, m)
	r = responseRows(t, m)[0]
	if r.Round != 2 {
		t.Fatalf("window resume did not send summary: %+v", r)
	}
	*now = now.Add(time.Minute)
	tickSend(t, m)
	*now = now.Add(time.Minute)
	tickSend(t, m)
	r = responseRows(t, m)[0]
	if r.Priority != "P1" || r.OriginalPriority != "P2" || r.Stage != "primary" || r.LevelActiveSeconds != 0 {
		t.Fatalf("priority escalation/reset incorrect: %+v", r)
	}
}

func TestResponseSilenceRecoveryAndLateClaim(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, _, now := managedFixture(t, receiver.URL)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	r := responseRows(t, m)[0]
	s := Silence{Scope: "incident", ResponseID: r.ID, From: stamp(*now), Until: stamp(now.Add(30 * time.Minute)), Reason: "maintenance", Timezone: "Asia/Shanghai"}
	request(t, mux, "POST", "/api/v1/alerts/silences", s, 200)
	*now = now.Add(20 * time.Minute)
	tickSend(t, m)
	r = responseRows(t, m)[0]
	if r.Round != 1 || r.ActiveSeconds != 0 {
		t.Fatalf("silence advanced timer: %+v", r)
	}
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"0"}}}}}}}, nil
	}
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	r = responseRows(t, m)[0]
	if r.State != "resolved" {
		t.Fatalf("not recovered: %+v", r)
	}
	memberRequest(t, mux, "u1", "/api/v1/alerts/incidents/"+r.ID+"/ack", nil, 409)
	*now = now.Add(11 * time.Minute)
	if e := m.NotifyResolved(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	var n int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_outbox WHERE event_id=?", r.ID+":resolved").Scan(&n)
	if n != 1 {
		t.Fatalf("recovery message missing %d", n)
	}
}

func TestOnCallCalendarMultiRespondersAndOverride(t *testing.T) {
	g := Group{Members: []string{"u1", "u2", "u3", "u4"}, Timezone: "Asia/Shanghai", Schedule: OnCallSchedule{Mode: "weekly", Timezone: "Asia/Shanghai", Anchor: "2026-10-12T01:00:00Z", Shifts: []OnCallShift{{Primary: []string{"u1", "u2"}, Backup: []string{"u4"}}, {Primary: []string{"u2", "u3"}, Backup: []string{"u1"}}}}}
	first := g.onCall(parse("2026-10-18T23:59:59Z"))
	second := g.onCall(parse("2026-10-19T01:00:00Z"))
	if encode(first.Primary) != encode([]string{"u1", "u2"}) || encode(second.Primary) != encode([]string{"u2", "u3"}) {
		t.Fatalf("bad weekly boundary %+v %+v", first, second)
	}
	g.Schedule.Overrides = []OnCallOverride{{From: "2026-10-19T02:00:00Z", Until: "2026-10-19T03:00:00Z", Primary: []string{"u4"}, Backup: []string{"u1", "u2"}}}
	if len(g.onCall(parse("2026-10-19T02:30:00Z")).Backup) != 2 || g.onCall(parse("2026-10-19T03:00:00Z")).Primary[0] != "u2" {
		t.Fatal("override boundary or multi-backup incorrect")
	}
	g.Schedule = OnCallSchedule{Mode: "daily", Timezone: "America/New_York", Anchor: "2026-10-31T13:00:00Z", Shifts: []OnCallShift{{Primary: []string{"u1"}}, {Primary: []string{"u2"}}}}
	if g.onCall(parse("2026-11-01T14:00:00Z")).Primary[0] != "u2" {
		t.Fatal("DST calendar shift changed")
	}
}

func TestAliyunAnsweredCallbackPersistsBeforeSendResult(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"Code": "OK", "CallId": "call-test"})
	}))
	defer receiver.Close()
	m, mux, rule, g, now := managedFixture(t, receiver.URL)
	var c Channel
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "voice", Type: "aliyun_voice", Enabled: true, Config: phoneConfig("aliyun_voice", receiver.URL)}, 200), &c)
	g.ChannelIDs = []string{c.ID}
	g.Primary = []string{"u1"}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"voice"}, RepeatSeconds: 10, MaxRounds: 5}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	public := http.NewServeMux()
	m.RegisterPublic(public)
	c, _ = m.channel(context.Background(), c.ID, true)
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(context.Background()); e != nil {
		t.Fatal(e)
	}
	path := "/api/v1/notify/callbacks/" + c.ID + "/" + c.Config["callback_token"]
	payload := []map[string]string{{"call_id": "call-test", "status_code": "200102", "status_time": now.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05")}}
	request(t, public, "POST", path, payload, 200)
	if responseRows(t, m)[0].State != "unclaimed" {
		t.Fatal("unmatched callback claimed a user")
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := m.ProcessVoiceReceipts(context.Background()); e != nil {
		t.Fatal(e)
	}
	r := responseRows(t, m)[0]
	if r.OwnerID != "u1" || r.AckMethod != "phone_answered" {
		t.Fatalf("phone answer did not claim %+v", r)
	}
	request(t, public, "POST", path, payload, 200)
	request(t, public, "POST", "/api/v1/notify/callbacks/"+c.ID+"/wrong", payload, 403)
	var n int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_response_events WHERE response_id=? AND json_extract(body,'$.kind')='acknowledged'", r.ID).Scan(&n)
	if n != 1 {
		t.Fatalf("duplicate phone ownership %d", n)
	}
	if phoneAnswered(c, map[string]any{"status_code": "200010"}) {
		t.Fatal("powered off treated as answered")
	}
}

func TestCommonRobotCardsContainClaimLink(t *testing.T) {
	for _, typ := range []string{"feishu", "dingtalk", "wecom"} {
		t.Run(typ, func(t *testing.T) {
			m, _ := testModule(t)
			receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data := map[string]any{}
				_ = json.NewDecoder(r.Body).Decode(&data)
				if !strings.Contains(encode(data), "https://monitor.example/alerts?claim=token") {
					t.Error("missing claim link")
				}
				if typ == "wecom" && !strings.Contains(valueString(data["markdown"].(map[string]any)["content"]), "<@member-1>") {
					t.Error("WeCom markdown lost on-call mention")
				}
				w.Header().Set("Content-Type", "application/json")
				if typ == "feishu" {
					w.Write([]byte(`{"code":0}`))
				} else {
					w.Write([]byte(`{"errcode":0}`))
				}
			}))
			defer receiver.Close()
			result := m.send(context.Background(), Channel{Type: typ, Config: map[string]string{"url": receiver.URL}}, Delivery{ID: "d", Recipient: Recipient{Mentions: []string{"member-1"}}, AckURL: "https://monitor.example/alerts?claim=token", Payload: Event{RuleName: "rule", Message: "test"}})
			if result.Status != "accepted" {
				t.Fatalf("%+v", result)
			}
		})
	}
}
