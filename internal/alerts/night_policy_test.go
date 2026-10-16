package alerts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func nightFixture(t *testing.T, level string) (*Module, *http.ServeMux, Rule, Group, *time.Time, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	voice, sms := &atomic.Int32{}, &atomic.Int32{}
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch r.Form.Get("Action") {
		case "SingleCallByTts":
			voice.Add(1)
		case "SendSms":
			sms.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"Code":"OK","CallId":"local-call","BizId":"local-sms"}`))
	}))
	t.Cleanup(receiver.Close)
	m, mux, rule, group, now := managedFixture(t, receiver.URL)
	group.Primary = []string{"u1"}
	group.ChannelIDs = nil
	for _, typ := range []string{"aliyun_voice", "aliyun_sms"} {
		var channel Channel
		config := phoneConfig(typ, receiver.URL)
		config["template_params"] = `{"name":"{{rule}}"}`
		if e := json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: typ, Type: typ, Enabled: true, Config: config}, 200), &channel); e != nil {
			t.Fatal(e)
		}
		group.ChannelIDs = append(group.ChannelIDs, channel.ID)
	}
	group.Policies = defaultPolicies()
	p := group.Policies["P1"]
	p.RepeatSeconds = 60
	group.Policies["P1"] = p
	if e := json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/groups/"+group.ID, group, 200), &group); e != nil {
		t.Fatal(e)
	}
	rule.Severity = level
	rule.ForSeconds, rule.ForCount = 0, 1
	if e := json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule); e != nil {
		t.Fatal(e)
	}
	*now = parse("2026-10-16T14:00:00Z") // 22:00 in Shanghai.
	return m, mux, rule, group, now, voice, sms
}

func evaluateTick(t *testing.T, m *Module, rule Rule, now time.Time) {
	t.Helper()
	if e := m.Evaluate(context.Background(), rule, now); e != nil {
		t.Fatal(e)
	}
	tickSend(t, m)
}

func TestNightPagingCountsAlarmRoundsAfterRuleTrigger(t *testing.T) {
	m, mux, rule, _, now, voice, sms := nightFixture(t, "P1")
	rule.ForCount = 3
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	for i := 0; i < 3; i++ {
		if i > 0 {
			*now = now.Add(10 * time.Second)
		}
		evaluateTick(t, m, rule, *now)
		if i < 2 && len(responseRows(t, m)) != 0 {
			t.Fatal("rule produced an incident before detection threshold")
		}
	}
	incident := responseRows(t, m)[0]
	if incident.NightCount != 1 || incident.Round != 0 || voice.Load() != 0 || sms.Load() != 0 {
		t.Fatalf("rule count leaked into notification count: %+v", incident)
	}
	for i := 0; i < 3; i++ {
		tickSend(t, m)
	}
	if responseRows(t, m)[0].NightCount != 1 {
		t.Fatal("worker scans inflated night rounds")
	}
	for i := 0; i < 6; i++ {
		*now = now.Add(10 * time.Second)
		evaluateTick(t, m, rule, *now)
	}
	if got := responseRows(t, m)[0]; got.NightCount != 2 || got.Round != 0 || voice.Load() != 0 {
		t.Fatalf("six more detections should add only one reminder round: %+v", got)
	}
	// Reopening the module uses the persisted counter without replaying rounds.
	restarted, e := New(m.deps)
	if e != nil {
		t.Fatal(e)
	}
	restarted.now = m.now
	m = restarted
	tickSend(t, m)
	if responseRows(t, m)[0].NightCount != 2 {
		t.Fatal("restart lost or inflated rounds")
	}
	for i := 0; i < 6; i++ {
		*now = now.Add(10 * time.Second)
		evaluateTick(t, m, rule, *now)
	}
	incident = responseRows(t, m)[0]
	if incident.NightCount != 3 || incident.Round != 1 || incident.Stage != "primary" || incident.LevelActiveSeconds != 0 || voice.Load() != 1 || sms.Load() != 0 {
		t.Fatalf("threshold must page primary by night methods: voice=%d sms=%d %+v", voice.Load(), sms.Load(), incident)
	}
	var count int
	if e := m.deps.DB.QueryRow("SELECT count(*) FROM alert_response_events WHERE response_id=? AND json_extract(body,'$.kind')='night_recorded'", incident.ID).Scan(&count); e != nil || count != 3 {
		t.Fatalf("record-only rounds not retained: %d, %v", count, e)
	}
}

func TestNightLevelsP0AlwaysPagesP2RecordsAndRetainsRecovery(t *testing.T) {
	for _, level := range []string{"P0", "P2"} {
		t.Run(level, func(t *testing.T) {
			m, mux, rule, _, now, voice, sms := nightFixture(t, level)
			evaluateTick(t, m, rule, *now)
			incident := responseRows(t, m)[0]
			if level == "P0" {
				if voice.Load() != 1 || sms.Load() != 1 {
					t.Fatalf("P0 did not page 24/7: voice=%d sms=%d", voice.Load(), sms.Load())
				}
				return
			}
			if voice.Load() != 0 || sms.Load() != 0 || incident.DeferredReason != "通知窗口外" {
				t.Fatalf("P2 notified at night: %+v", incident)
			}
			m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
				return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"0"}}}}}}}, nil
			}
			*now = now.Add(time.Minute)
			evaluateTick(t, m, rule, *now)
			*now = parse("2026-10-17T01:00:00Z")
			tickSend(t, m)
			if e := m.NotifyResolved(context.Background()); e != nil {
				t.Fatal(e)
			}
			events := string(request(t, mux, "GET", "/api/v1/alerts/events", nil, 200))
			incidents := string(request(t, mux, "GET", "/api/v1/alerts/incidents", nil, 200))
			if !strings.Contains(events, `"kind":"firing"`) || !strings.Contains(events, `"kind":"resolved"`) || !strings.Contains(incidents, `"state":"resolved"`) || voice.Load() != 0 || sms.Load() != 0 {
				t.Fatalf("overnight record lost or stale alert sent next day: %s %s", events, incidents)
			}
		})
	}
}

func TestNightCounterResetsOnEvaluationGapAndRecovery(t *testing.T) {
	m, _, rule, _, now, voice, _ := nightFixture(t, "P1")
	evaluateTick(t, m, rule, *now)
	*now = now.Add(30 * time.Second) // No evaluations for >2 intervals.
	evaluateTick(t, m, rule, *now)
	if got := responseRows(t, m)[0]; got.NightCount != 1 || voice.Load() != 0 {
		t.Fatalf("gap was counted as sustained alarm: %+v", got)
	}
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"0"}}}}}}}, nil
	}
	*now = now.Add(10 * time.Second)
	evaluateTick(t, m, rule, *now)
	if responseRows(t, m)[0].State != "resolved" {
		t.Fatal("record-only alert did not recover")
	}
}

func TestDaytimeRestoresNotificationsForStillOpenNightIncident(t *testing.T) {
	m, _, rule, _, now, voice, sms := nightFixture(t, "P1")
	*now = parse("2026-10-16T13:59:59Z")
	evaluateTick(t, m, rule, *now)
	if voice.Load() != 1 || sms.Load() != 1 {
		t.Fatal("daytime P1 must use both voice and SMS")
	}
	*now = now.Add(time.Second)
	evaluateTick(t, m, rule, *now)
	if responseRows(t, m)[0].NightCount != 1 || voice.Load() != 1 || sms.Load() != 1 {
		t.Fatal("entering night did not defer notification")
	}
	*now = parse("2026-10-17T01:00:00Z")
	evaluateTick(t, m, rule, *now)
	// The first worker tick may query overdue receipts for the same accounts.
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if voice.Load() != 2 || sms.Load() != 2 {
		t.Fatalf("daytime did not resume current incident: voice=%d sms=%d", voice.Load(), sms.Load())
	}
}

func TestNightInstanceCountsDoNotMix(t *testing.T) {
	m, mux, rule, _, now, voice, _ := nightFixture(t, "P1")
	rule.LabelFields = []string{"instance"}
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule)
	valueB := "100"
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "instance", Type: "String"}, {Name: "value", Type: "UInt64"}}, Rows: [][]any{{"a", "100"}, {"b", valueB}}}}}}}, nil
	}
	evaluateTick(t, m, rule, *now)
	for i := 1; i <= 12; i++ {
		*now = now.Add(10 * time.Second)
		if i == 3 {
			valueB = "0"
		}
		if i == 9 {
			valueB = "100"
		}
		evaluateTick(t, m, rule, *now)
	}
	for _, incident := range responseRows(t, m) {
		if incident.Event.State.Labels["instance"] == "b" && incident.State == "unclaimed" && (incident.NightCount != 1 || incident.Round != 0) {
			t.Fatalf("another instance's rounds leaked into b: %+v", incident)
		}
	}
	if voice.Load() != 1 {
		t.Fatalf("only continuously firing instance a should page: %d", voice.Load())
	}
}

func TestQueuedDaytimeVoiceCannotBypassNightMethod(t *testing.T) {
	m, mux, rule, group, now, voice, sms := nightFixture(t, "P1")
	p := group.Policies["P1"]
	p.NightMode, p.NightMethods = "immediate", []string{"sms"}
	group.Policies["P1"] = p
	request(t, mux, "PUT", "/api/v1/alerts/groups/"+group.ID, group, 200)
	*now = parse("2026-10-16T13:59:59Z")
	if e := m.Evaluate(context.Background(), rule, *now); e != nil {
		t.Fatal(e)
	}
	if e := m.TickResponses(context.Background()); e != nil {
		t.Fatal(e)
	}
	*now = now.Add(time.Second)
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if voice.Load() != 0 || sms.Load() != 1 {
		t.Fatalf("daytime queue bypassed night channel selection: voice=%d sms=%d", voice.Load(), sms.Load())
	}
}

func TestNightPolicyValidationAndWindowBoundaries(t *testing.T) {
	_, mux, _, group, _, _, _ := nightFixture(t, "P1")
	for _, patch := range []PriorityPolicy{
		{NightMode: "unknown"}, {NightMode: "after_count", NightAfterCount: 0, NightMethods: []string{"voice"}},
		{NightMode: "after_count", NightAfterCount: 1001, NightMethods: []string{"voice"}},
		{NightMode: "immediate"}, {NightMode: "immediate", NightMethods: []string{"invalid"}},
	} {
		p := group.Policies["P1"]
		p.NightMode, p.NightAfterCount, p.NightMethods = patch.NightMode, patch.NightAfterCount, patch.NightMethods
		candidate := group
		candidate.Policies = map[string]PriorityPolicy{"P1": p}
		request(t, mux, "PUT", "/api/v1/alerts/groups/"+group.ID, candidate, 400)
	}
	r := IncidentResponse{Priority: "P1", Group: group}
	if r.nightPeriod(parse("2026-10-16T13:59:59Z")) != "" || r.nightPeriod(parse("2026-10-16T14:00:00Z")) == "" || r.nightPeriod(parse("2026-10-17T01:00:00Z")) != "" {
		t.Fatal("day/night boundaries do not match 09:00–22:00 Shanghai")
	}
	if r.nightPeriod(parse("2026-10-16T15:00:00Z")) != r.nightPeriod(parse("2026-10-17T00:59:59Z")) || r.nightPeriod(parse("2026-10-16T15:00:00Z")) == r.nightPeriod(parse("2026-10-17T15:00:00Z")) {
		t.Fatal("counts do not belong to a single overnight window")
	}
}

func TestExistingGroupsWithoutPoliciesKeepOriginalNotifications(t *testing.T) {
	m, mux, _, group, _, _, _ := nightFixture(t, "P1")
	group.Policies = nil
	if _, e := m.deps.DB.Exec("UPDATE alert_groups SET body=? WHERE id=?", encode(group), group.ID); e != nil {
		t.Fatal(e)
	}
	loaded, e := m.group(context.Background(), group.ID)
	if e != nil || loaded.policy("P1").NightMode != "" || includes(loaded.policy("P1").Methods, "voice") || loaded.policy("P2").EscalateAfterRounds != 3 {
		t.Fatalf("old default policies were reinterpreted: %+v, %v", loaded.Policies, e)
	}
	var groups []Group
	_ = json.Unmarshal(request(t, mux, "GET", "/api/v1/alerts/groups", nil, 200), &groups)
	for _, g := range groups {
		if g.ID == group.ID && (g.Policies["P1"].NightMode != "" || includes(g.Policies["P1"].Methods, "voice")) {
			t.Fatal("editor API returned the new template for an existing group")
		}
	}
	group.ID, group.Revision, group.Name = "", 0, "new group"
	var created Group
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/alerts/groups", group, 200), &created)
	if created.policy("P1").NightMode != "after_count" || !includes(created.policy("P1").Methods, "voice") || created.policy("P2").EscalateAfterRounds != 0 {
		t.Fatalf("new groups did not use the new template: %+v", created.Policies)
	}
}
