package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestResponsePauseResumeAndMeasurementReplacement(t *testing.T) {
	m, mux, rule, _, now := managedFixture(t, "http://localhost/no-send")
	ctx := context.Background()
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	first := responseRows(t, m)[0]
	rule.Enabled = false
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	paused, _ := m.response(ctx, first.ID)
	if paused.State != "cancelled" {
		t.Fatal("pause did not cancel response", paused)
	}
	request(t, mux, "POST", "/api/v1/alerts/incidents/"+first.ID+"/escalate", nil, 403)
	request(t, mux, "POST", "/api/v1/alerts/incidents/"+first.ID+"/transfer", map[string]string{"user_id": "u2"}, 403)
	*now = now.Add(time.Hour)
	rule.Enabled = true
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	resumed, _ := m.response(ctx, first.ID)
	if resumed.Episode != first.Episode || resumed.State != "unclaimed" || resumed.LevelActiveSeconds != 0 {
		t.Fatalf("resume duplicated or counted paused time: %+v", resumed)
	}
	rule.Threshold = "11"
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	replaced, _ := m.response(ctx, first.ID)
	rows := responseRows(t, m)
	if replaced.State != "cancelled" || len(rows) != 2 {
		t.Fatalf("measurement change did not replace old response %+v", rows)
	}
	for _, v := range rows {
		if v.ID != first.ID && v.Episode == first.Episode {
			t.Fatal("new measurement reused old episode")
		}
	}
}

func TestInheritedRouteChangeWithoutReminderAndIndependentGroups(t *testing.T) {
	m, mux, rule, g, now := managedFixture(t, "http://localhost/no-send")
	ctx := context.Background()
	rule.GroupIDs = nil
	rule.RepeatSeconds = 0
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	first := responseRows(t, m)[0]
	b, _ := m.group(ctx, "group-b")
	b.Members, b.Primary, b.Backup, b.Fallback = g.Members, g.Primary, g.Backup, g.Fallback
	b.ChannelIDs, b.Policies, b.Timezone = g.ChannelIDs, g.Policies, g.Timezone
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+b.ID, b, 200)
	// Catalog binding is external to this module and doesn't produce a reminder.
	m.deps.Catalog = func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "metric_http_sum", Name: "metric_http_sum", AlertGroupID: b.ID, Services: []string{"api"}}}, nil
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	old, _ := m.response(ctx, first.ID)
	if old.State != "cancelled" {
		t.Fatal("old responsibility was not cancelled")
	}
	rows := responseRows(t, m)
	if len(rows) != 2 {
		t.Fatalf("new responsibility requires no reminders: %+v", rows)
	}
	var active IncidentResponse
	for _, v := range rows {
		if v.GroupID == b.ID {
			active = v
		}
	}
	if active.Episode != first.Episode || active.State != "unclaimed" || active.Round != 1 {
		t.Fatalf("route changed episode or failed dispatch %+v", active)
	}
	// The original cancelled response is immutable; use a new third group.
	c := g
	c.ID, c.Name, c.Revision = "group-c", "another responsibility", 0
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+c.ID, c, 200)
	rule.GroupIDs = []string{b.ID, c.ID}
	_, _ = m.deps.DB.Exec("UPDATE alert_rules SET body=? WHERE id=?", encode(rule), rule.ID)
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e := m.acknowledge(ctx, active.ID, "u1", "web", *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	for _, v := range responseRows(t, m) {
		if v.GroupID == c.ID && v.State != "unclaimed" {
			t.Fatal("one group's acknowledgement stopped another", v)
		}
	}
}

func TestNativeVoiceContextRecoversLostSendResultAndStaleWrites(t *testing.T) {
	m, mux, rule, g, now := managedFixture(t, "http://localhost/no-send")
	var c Channel
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "voice", Type: "aliyun_voice", Enabled: true, Config: phoneConfig("aliyun_voice", "http://localhost/no-send")}, 200), &c)
	g.ChannelIDs, g.Primary = []string{c.ID}, []string{"u1"}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"voice"}, RepeatSeconds: 10, MaxRounds: 2}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	ctx := context.Background()
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	ds, _ := listBodies[Delivery](ctx, m.deps.DB, "SELECT body FROM alert_outbox")
	d := ds[0]
	d.Status = "unknown"
	if e := m.updateDelivery(ctx, d); e != nil {
		t.Fatal(e)
	}
	c, _ = m.channel(ctx, c.ID, true)
	public := http.NewServeMux()
	m.RegisterPublic(public)
	request(t, public, "POST", "/api/v1/notify/callbacks/"+c.ID+"/"+c.Config["callback_token"], []map[string]string{{"call_id": "lost-call", "out_id": d.ID, "status_code": "200102", "status_time": now.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04:05")}}, 200)
	if responseRows(t, m)[0].OwnerID != "u1" {
		t.Fatal("native context did not compensate for lost CallID")
	}
	var notified int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_assignments WHERE ack_method='phone_answered'").Scan(&notified)
	if notified != 1 {
		t.Fatal("native compensation lost phone acknowledgement statistics")
	}
	if e := m.updateDelivery(ctx, d); e != nil {
		t.Fatal(e)
	}
	ds, _ = listBodies[Delivery](ctx, m.deps.DB, "SELECT body FROM alert_outbox")
	if ds[0].Status != "confirmed" || ds[0].DeliveryStatus != "answered" || ds[0].ProviderID != "lost-call" {
		t.Fatal("late sender overwrote the answer", ds[0])
	}
	if phoneAnswered(c, map[string]any{"status_code": "200010"}) {
		t.Fatal("powered-off phone was treated as answered")
	}
}

func TestReplanPreservesOwnerAndHistory(t *testing.T) {
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer receiver.Close()
	m, mux, rule, g, now := managedFixture(t, receiver.URL)
	ctx := context.Background()
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
	r := responseRows(t, m)[0]
	if _, e := m.acknowledge(ctx, r.ID, "u1", "web", *now); e != nil {
		t.Fatal(e)
	}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"webhook"}, RepeatSeconds: 60, MaxRounds: 2}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	request(t, mux, "POST", "/api/v1/alerts/incidents/"+r.ID+"/replan", nil, 200)
	after, _ := m.response(ctx, r.ID)
	if after.OwnerID != "u1" || after.State != "acknowledged" || after.Group.policy("P0").RepeatSeconds != 60 {
		t.Fatal("replan released ownership", after)
	}
	var assignments int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_assignments WHERE response_id=?", r.ID).Scan(&assignments)
	if assignments != 2 {
		t.Fatal("replan deleted immutable notification history")
	}
}

func TestUnreachablePrimaryAndBackupStillReachFallback(t *testing.T) {
	m, mux, rule, g, now := managedFixture(t, "http://localhost/no-send")
	var channel Channel
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "personal cards", Type: "feishu_app", Enabled: true, Config: map[string]string{"app_id": "app", "app_secret": "secret", "verification_token": "verify"}}, 200), &channel)
	g.ChannelIDs = []string{channel.ID}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"chat"}, RepeatSeconds: 10, MaxRounds: 2}
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+g.ID, g, 200)
	_, _ = m.deps.DB.Exec("UPDATE user_notification_profiles SET body=json_set(body,'$.feishu_id','') WHERE user_id IN ('u1','u2','u3')")
	ctx := context.Background()
	if e := m.Evaluate(ctx, rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(ctx); e != nil {
		t.Fatal(e)
	}
	r := responseRows(t, m)[0]
	ds, _ := listBodies[Delivery](ctx, m.deps.DB, "SELECT body FROM alert_outbox")
	if r.Exhausted || r.Stage != "fallback" || len(ds) != 1 || ds[0].UserID != "u4" {
		t.Fatalf("missing contacts stopped before valid fallback: %+v %+v", r, ds)
	}
}

func TestFailingDirectoryDoesNotStarveOtherSources(t *testing.T) {
	var calls atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(503) }))
	defer receiver.Close()
	m, mux, _, g, _ := managedFixture(t, receiver.URL)
	for _, id := range []string{"first", "second"} {
		request(t, mux, "PUT", "/api/v1/settings/alert-directory-sources/"+id, DirectorySource{ID: id, Name: id, URL: receiver.URL, GroupID: g.ID, Enabled: true, IntervalSeconds: 60}, 200)
	}
	if e := m.SyncDueDirectories(context.Background()); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 2 {
		t.Fatal("first failing hook starved another group")
	}
	if e := m.SyncDueDirectories(context.Background()); e != nil {
		t.Fatal(e)
	}
	if calls.Load() != 2 {
		t.Fatal("failed sources retried before configured interval")
	}
}

func TestDingtalkUserIDPreferredOverPhone(t *testing.T) {
	m, mux, _, g, _ := managedFixture(t, "http://localhost/no-send")
	var c Channel
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "ding", Type: "dingtalk", Enabled: true, Config: map[string]string{"url": "http://localhost/no-send"}}, 200), &c)
	_, _ = m.deps.DB.Exec("UPDATE user_notification_profiles SET body=json_set(body,'$.dingtalk_id','staff-1') WHERE user_id='u1'")
	g.ChannelIDs = []string{c.ID}
	g.Policies["P0"] = PriorityPolicy{Methods: []string{"chat"}}
	targets, _, e := m.responseTargets(context.Background(), g, "P0", []string{"u1"})
	if e != nil || len(targets) != 1 || len(targets[0].Target.Recipient.Mentions) != 1 || targets[0].Target.Recipient.Mentions[0] != "staff-1" {
		t.Fatal("configured DingTalk staff ID ignored", targets, e)
	}
}
