package alerts

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/lightmoni/lightmoni/internal/query"
	"github.com/lightmoni/lightmoni/internal/shared"
	_ "modernc.org/sqlite"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testModule(t *testing.T) (*Module, *http.ServeMux) {
	t.Helper()
	db, e := sql.Open("sqlite", ":memory:")
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	deps := shared.Dependencies{DB: db, Query: func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{RefID: "A", Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"100"}}}}}}}, nil
	}, Catalog: func(context.Context) ([]shared.Table, error) {
		return []shared.Table{{ID: "metric_http_sum", Name: "metric_http_sum", AlertGroupID: "group-a", Services: []string{"api"}}, {ID: "log_app", Name: "log_app", AlertGroupID: "group-b"}}, nil
	}, ReferencedTables: func(_ context.Context, s string) ([]string, error) {
		return query.ReferencedTables(s, map[string]bool{"metric_http_sum": true, "log_app": true})
	}, Encrypt: func(s string) (string, error) { return base64.StdEncoding.EncodeToString([]byte(s)), nil }, Decrypt: func(s string) (string, error) { b, e := base64.StdEncoding.DecodeString(s); return string(b), e }}
	m, e := New(deps)
	if e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	return m, mux
}
func request(t *testing.T, mux *http.ServeMux, method, path string, body any, status int) []byte {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(encode(body)))
	req = req.WithContext(shared.WithUser(req.Context(), shared.User{ID: "admin", Role: "admin"}))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != status {
		t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}
func seed(t *testing.T, m *Module, mux *http.ServeMux, endpoint string) Rule {
	t.Helper()
	raw := request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: "Local", Type: "webhook", Enabled: true, Config: map[string]string{"url": endpoint, "secret": "sign-secret"}}, 200)
	var c Channel
	json.Unmarshal(raw, &c)
	target := Target{c.ID, Recipient{Kind: "channel", Value: "bound"}}
	for _, gid := range []string{"group-a", "group-b"} {
		request(t, mux, "PUT", "/api/v1/alerts/groups/"+gid, Group{Name: gid, Enabled: true, Targets: []Target{target}}, 200)
	}
	r := Rule{Kind: "sql", Name: "HTTP errors", Enabled: true, SQL: "SELECT sum(value) AS value FROM metric_http_sum", SourceTableIDs: []string{"metric_http_sum"}, ValueField: "value", Operator: "gt", Threshold: "10", IntervalSeconds: 10, WindowSeconds: 60, ForSeconds: 10, NotifyHealth: true}
	raw = request(t, mux, "POST", "/api/v1/alerts/rules", r, 200)
	json.Unmarshal(raw, &r)
	return r
}
func TestSingleConnectionStateOutboxAndRetry(t *testing.T) {
	m, mux := testModule(t)
	calls := 0
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-LightMoni-Signature") == "" {
			t.Error("signature missing")
		}
		if calls == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(429)
			return
		}
		w.WriteHeader(202)
	}))
	defer receiver.Close()
	r := seed(t, m, mux, receiver.URL)
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	if len(states) != 1 || states[0].Status != "pending" {
		t.Fatalf("%+v", states)
	}
	now = now.Add(11 * time.Second)
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	if e := m.Evaluate(context.Background(), r, now.Add(time.Second)); e != nil {
		t.Fatal(e)
	}
	events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events")
	if len(events) != 1 || events[0].Kind != "firing" {
		t.Fatalf("events %+v", events)
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	var status string
	m.deps.DB.QueryRow("SELECT status FROM alert_outbox").Scan(&status)
	if status != "retry" {
		t.Fatal(status)
	}
	now = now.Add(10 * time.Second)
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	m.deps.DB.QueryRow("SELECT status FROM alert_outbox").Scan(&status)
	if status != "accepted" || calls != 2 {
		t.Fatalf("status=%s calls=%d", status, calls)
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if calls != 2 {
		t.Fatal("accepted webhook was sent twice")
	}
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{}, errors.New("database unavailable")
	}
	now = now.Add(5 * time.Second)
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	states, _ = listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	for _, s := range states {
		if s.Episode != "" && s.Status != "firing" {
			t.Fatal("query error incorrectly resolved episode")
		}
	}
	var raw string
	m.deps.DB.QueryRow("SELECT secret FROM alert_channels").Scan(&raw)
	if strings.Contains(raw, "sign-secret") {
		t.Fatal("secret stored plaintext")
	}
	listed := request(t, mux, "GET", "/api/v1/notify/channels", nil, 200)
	if strings.Contains(string(listed), "sign-secret") || strings.Contains(string(listed), receiver.URL) {
		t.Fatal("secret exposed in API")
	}
}
func TestASTDeclarationAndCrossTableDedup(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://localhost/hook")
	r.SQL = "SELECT count() AS value FROM metric_http_sum JOIN log_app ON 1=1"
	if e := m.validateRule(context.Background(), &r); e == nil {
		t.Fatal("undeclared table accepted")
	}
	r.SourceTableIDs = append(r.SourceTableIDs, "log_app")
	if e := m.validateRule(context.Background(), &r); e != nil {
		t.Fatal(e)
	}
	routes, warnings, e := m.route(context.Background(), r)
	if e != nil || len(routes) != 1 || len(routes[0].GroupIDs) != 2 || len(warnings) != 0 {
		t.Fatalf("routes=%+v warnings=%v err=%v", routes, warnings, e)
	}
	r.SQL = "SELECT count() AS value FROM (SELECT * FROM log_app)"
	if e := m.validateRule(context.Background(), &r); e == nil {
		t.Fatal("overdeclared table accepted")
	}
}
func TestNumericPrecisionAndInterruptedPending(t *testing.T) {
	if !breached("18446744073709551615", "18446744073709551614", "gt") {
		t.Fatal("uint64 precision lost")
	}
	if !breached("0.10000000000000000001", "0.1", "gt") {
		t.Fatal("decimal precision lost")
	}
	now := time.Now()
	r := Rule{ID: "r", IntervalSeconds: 10, ForSeconds: 60}
	in := State{Fingerprint: "a", Labels: map[string]string{}, Health: "ok", Status: "firing"}
	s, k := transition(State{}, in, r, now)
	if s.Status != "pending" || len(k) != 0 {
		t.Fatal(s, k)
	}
	s, k = transition(s, in, r, now.Add(2*time.Minute))
	if s.Status != "pending" || len(k) != 0 {
		t.Fatal("downtime counted toward pending", s, k)
	}
}
func TestProviderSignaturesAndBusinessFailures(t *testing.T) {
	m, _ := testModule(t)
	now := time.Unix(1700000000, 0)
	m.now = func() time.Time { return now }
	for _, typ := range []string{"feishu", "dingtalk", "wecom", "pushplus"} {
		t.Run(typ, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				switch typ {
				case "feishu":
					if body["sign"] != feishuSign("1700000000", "secret") {
						t.Error("feishu signature")
					}
				case "dingtalk":
					if r.URL.Query().Get("sign") != dingSign("1700000000000", "secret") {
						t.Error("ding signature")
					}
				}
				if typ == "feishu" {
					w.Write([]byte(`{"code":19021,"msg":"sign error"}`))
				} else if typ == "pushplus" {
					w.Write([]byte(`{"code":905,"msg":"invalid account"}`))
				} else {
					w.Write([]byte(`{"errcode":310000,"errmsg":"security error"}`))
				}
			}))
			defer server.Close()
			c := Channel{Type: typ, Config: map[string]string{"url": server.URL, "endpoint": server.URL, "secret": "secret", "token": "token", "push_channel": "wechat"}}
			result := m.send(context.Background(), c, Delivery{ID: "d", EventID: "e", Recipient: Recipient{Kind: "channel"}, Payload: Event{Message: "test"}})
			if result.Status != "failed" || result.Retryable {
				t.Fatalf("HTTP 200 error treated as success: %+v", result)
			}
		})
	}
}
func TestPushplusReceipt(t *testing.T) {
	m, _ := testModule(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("access-key") != "access" || r.URL.Query().Get("shortCode") != "receipt-id" {
			t.Error("receipt request auth")
		}
		w.Write([]byte(`{"code":200,"data":{"status":3,"errorMessage":"recipient unavailable"}}`))
	}))
	defer server.Close()
	result := m.receipt(context.Background(), Channel{Type: "pushplus", Config: map[string]string{"access_key": "access", "receipt_endpoint": server.URL}}, Delivery{ProviderID: "receipt-id"})
	if result.Status != "failed" {
		t.Fatal(result)
	}
}
func TestSMSRequestSigningAndUnknown(t *testing.T) {
	m, _ := testModule(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if e := r.ParseForm(); e != nil {
			t.Fatal(e)
		}
		p := map[string]string{}
		for k, v := range r.Form {
			if k != "Signature" {
				p[k] = v[0]
			}
		}
		if r.Form.Get("Signature") != smsSignature(p, "SECRET") {
			t.Error("SMS signature mismatch")
		}
		if r.Form.Get("PhoneNumbers") != "13800000000" {
			t.Error("recipient missing")
		}
		w.Write([]byte(`{"Code":"OK","BizId":"sms-id"}`))
	}))
	defer server.Close()
	c := Channel{Type: "aliyun_sms", Config: map[string]string{"endpoint": server.URL, "access_key_id": "ID", "access_key_secret": "SECRET", "sign_name": "test", "template_code": "SMS_TEST"}}
	result := m.send(context.Background(), c, Delivery{Recipient: Recipient{Kind: "phone", Value: "13800000000"}, Payload: Event{RuleName: "test"}})
	if result.Status != "accepted" || result.ProviderID != "sms-id" {
		t.Fatal(result)
	}
	c.Config["endpoint"] = "http://127.0.0.1:1"
	result = m.send(context.Background(), c, Delivery{Recipient: Recipient{Kind: "phone", Value: "13800000000"}})
	if result.Status != "unknown" || result.Retryable {
		t.Fatal("unknown SMS must not automatically retry", result)
	}
}
func TestEmailAndRecipientValidation(t *testing.T) {
	p := Recipient{Kind: "email", Value: "user@example.com"}
	if validateRecipient("smtp", &p) != nil {
		t.Fatal("valid recipient")
	}
	p.Value = "evil@example.com\r\nBcc: victim@example.com"
	if validateRecipient("smtp", &p) == nil {
		t.Fatal("header injection")
	}
	p = Recipient{Kind: "phone", Value: "13800000000,13900000000"}
	if validateRecipient("aliyun_sms", &p) == nil {
		t.Fatal("multiple phone recipient")
	}
}

func TestSMTPServerReceivesMessage(t *testing.T) {
	m, _ := testModule(t)
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	messages := make(chan string, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		rw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
		reply := func(s string) { _, _ = rw.WriteString(s + "\r\n"); _ = rw.Flush() }
		reply("220 local test SMTP")
		for {
			line, e := rw.ReadString('\n')
			if e != nil {
				return
			}
			line = strings.TrimSpace(line)
			switch {
			case strings.HasPrefix(line, "EHLO"), strings.HasPrefix(line, "HELO"):
				reply("250 localhost")
			case strings.HasPrefix(line, "MAIL FROM"), strings.HasPrefix(line, "RCPT TO"):
				reply("250 accepted")
			case line == "DATA":
				reply("354 end with dot")
				var body strings.Builder
				for {
					line, e = rw.ReadString('\n')
					if e != nil {
						return
					}
					if line == ".\r\n" {
						break
					}
					body.WriteString(line)
				}
				messages <- body.String()
				reply("250 queued")
			case line == "QUIT":
				reply("221 bye")
				return
			default:
				reply("500 unexpected")
			}
		}
	}()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	r := m.send(context.Background(), Channel{Type: "smtp", Config: map[string]string{"host": host, "port": port, "tls": "none", "from": "lightmoni@example.com"}}, Delivery{ID: "stable-id", Recipient: Recipient{Kind: "email", Value: "ops@example.com"}, Payload: Event{RuleName: "CPU threshold", Kind: "firing", Message: "CPU is high"}})
	if r.Status != "accepted" {
		t.Fatal(r)
	}
	select {
	case body := <-messages:
		if !strings.Contains(body, "CPU is high") || !strings.Contains(body, "Message-ID: <stable-id@lightmoni>") {
			t.Fatal(body)
		}
	case <-time.After(time.Second):
		t.Fatal("mail not received")
	}
}

func TestHistoryDoesNotStarveQueueAndEpisodeOrder(t *testing.T) {
	m, mux := testModule(t)
	now := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	m.now = func() time.Time { return now }
	calls := []string{}
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Event Event `json:"event"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, body.Event.Kind)
		w.WriteHeader(202)
	}))
	defer receiver.Close()
	r := seed(t, m, mux, receiver.URL)
	r.ForSeconds = 0
	var saved Rule
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &saved)
	r = saved
	chs, _ := listBodies[Channel](context.Background(), m.deps.DB, "SELECT body FROM alert_channels")
	c := chs[0]
	for i := 0; i < 150; i++ {
		d := Delivery{ID: id(), EventID: id(), ChannelID: c.ID, Recipient: Recipient{Kind: "channel", Value: "bound"}, Status: "accepted", CreatedAt: stamp(now.Add(-time.Hour)), NextAttempt: ""}
		_, e := m.deps.DB.Exec("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, recipientKey(d.Recipient), d.Status, d.NextAttempt, d.CreatedAt, encode(d))
		if e != nil {
			t.Fatal(e)
		}
	}
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	if e := m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(calls) != 1 || calls[0] != "firing" {
		t.Fatal("history starved active delivery", calls)
	}
	// Hold a reminder in backoff. A later recovery must wait rather than overtaking it.
	ds, _ := listBodies[Delivery](context.Background(), m.deps.DB, "SELECT body FROM alert_outbox WHERE event_id IN (SELECT id FROM alert_events)")
	first := ds[0]
	first.ID = id()
	first.EventID = id()
	first.Payload.Kind = "reminder"
	first.Status = "retry"
	first.CreatedAt = stamp(now.Add(time.Second))
	first.NextAttempt = stamp(now.Add(time.Minute))
	_, e := m.deps.DB.Exec("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", first.ID, first.EventID, first.ChannelID, recipientKey(first.Recipient), first.Status, first.NextAttempt, first.CreatedAt, encode(first))
	if e != nil {
		t.Fatal(e)
	}
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"0"}}}}}}}, nil
	}
	now = now.Add(11 * time.Second)
	if e = m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	if e = m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if len(calls) != 1 {
		t.Fatal("recovery overtook earlier retry", calls)
	}
	now = now.Add(time.Minute)
	if e = m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	now = now.Add(time.Minute)
	if e = m.SendPending(context.Background()); e != nil {
		t.Fatal(e)
	}
	if strings.Join(calls, ",") != "firing,reminder,resolved" {
		t.Fatal(calls)
	}
}

func TestRestartPersistsStateAndMarksUncertainSend(t *testing.T) {
	prototype, _ := testModule(t)
	path := t.TempDir() + "/alerts.db"
	open := func() *sql.DB {
		db, e := sql.Open("sqlite", path)
		if e != nil {
			t.Fatal(e)
		}
		db.SetMaxOpenConns(1)
		return db
	}
	db := open()
	deps := prototype.deps
	deps.DB = db
	m, e := New(deps)
	if e != nil {
		t.Fatal(e)
	}
	states := []State{{RuleID: "r", Fingerprint: "pending", Status: "pending", Health: "ok", Since: stamp(time.Now().Add(-time.Hour))}, {RuleID: "r", Fingerprint: "firing", Status: "firing", Health: "error", Episode: "kept-episode", HealthSince: stamp(time.Now().Add(-time.Hour))}, {RuleID: "r", Fingerprint: "recovering", Status: "recovering", Health: "ok", Episode: "second-episode"}}
	for _, s := range states {
		if _, e = db.Exec("INSERT INTO alert_states(rule_id,fingerprint,body) VALUES(?,?,?)", s.RuleID, s.Fingerprint, encode(s)); e != nil {
			t.Fatal(e)
		}
	}
	d := Delivery{ID: "uncertain", EventID: "event", ChannelID: "channel", Status: "sending", CreatedAt: stamp(time.Now()), NextAttempt: stamp(time.Now())}
	if _, e = db.Exec("INSERT INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, "target", d.Status, d.NextAttempt, d.CreatedAt, encode(d)); e != nil {
		t.Fatal(e)
	}
	if e = db.Close(); e != nil {
		t.Fatal(e)
	}
	db = open()
	defer db.Close()
	deps.DB = db
	m, e = New(deps)
	if e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { m.Run(ctx); close(done) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		var status string
		_ = db.QueryRow("SELECT status FROM alert_outbox WHERE id='uncertain'").Scan(&status)
		got, _ := listBodies[State](context.Background(), db, "SELECT body FROM alert_states WHERE fingerprint='pending'")
		if status == "unknown" && len(got) == 1 && got[0].Status == "normal" {
			break
		}
		time.Sleep(time.Millisecond * 5)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("workers did not stop")
	}
	var status string
	_ = db.QueryRow("SELECT status FROM alert_outbox WHERE id='uncertain'").Scan(&status)
	if status != "unknown" {
		t.Fatal(status)
	}
	got, _ := listBodies[State](context.Background(), db, "SELECT body FROM alert_states")
	for _, s := range got {
		if s.Fingerprint == "pending" && (s.Status != "normal" || s.Since != "") {
			t.Fatal(s)
		}
		if s.Fingerprint == "firing" && (s.Status != "firing" || s.Episode != "kept-episode") {
			t.Fatal(s)
		}
		if s.Fingerprint == "recovering" && (s.Status != "firing" || s.Episode != "second-episode") {
			t.Fatal(s)
		}
	}
}

func TestMetadataEditKeepsEpisodeAndDestinationChangeCancelsQueue(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://localhost/original")
	r.ForSeconds = 0
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	now := time.Now()
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	before, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	r.Name = "New display name"
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	after, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	if len(after) != 1 || after[0].Episode != before[0].Episode || after[0].Episode == "" {
		t.Fatal("display edit lost active episode", after)
	}
	r.Enabled = false
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	after, _ = listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	if after[0].Episode != before[0].Episode {
		t.Fatal("pause lost episode")
	}
	chs, _ := listBodies[Channel](context.Background(), m.deps.DB, "SELECT body FROM alert_channels")
	c := chs[0]
	request(t, mux, "POST", "/api/v1/notify/channels/"+c.ID+"/test", map[string]any{"recipient": Recipient{Kind: "channel", Value: "bound"}}, 200)
	c.Config["url"] = "http://localhost/new-target"
	request(t, mux, "PUT", "/api/v1/notify/channels/"+c.ID, c, 200)
	var queued int
	_ = m.deps.DB.QueryRow("SELECT count(*) FROM alert_outbox WHERE status IN ('queued','retry')").Scan(&queued)
	if queued != 0 {
		t.Fatal("pending event could be redirected")
	}
}

func TestNumericSchemaGroupedNullsAndAccountRestriction(t *testing.T) {
	m, _ := testModule(t)
	if numericType("String") || !numericType("Nullable(Decimal(38, 9))") {
		t.Fatal("numeric column type validation")
	}
	now := time.Now()
	r := Rule{Kind: "sql", ID: "r", Name: "r", SQL: "SELECT 1", ValueField: "value", LabelFields: []string{"service"}, Threshold: "1", Operator: "gt", IntervalSeconds: 10, WindowSeconds: 60}
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}, {Name: "service", Type: "Nullable(String)"}}, Rows: [][]any{{"2", nil}, {"2", "<nil>"}}}}}}}, nil
	}
	p, e := m.inspect(context.Background(), r, now)
	if e != nil || len(p.States) != 2 || p.States[0].Fingerprint == p.States[1].Fingerprint {
		t.Fatal("null and string dimensions collapsed", p, e)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"code":900,"msg":"account restricted"}`))
	}))
	defer server.Close()
	result := m.send(context.Background(), Channel{Type: "pushplus", Config: map[string]string{"token": "token", "push_channel": "wechat", "endpoint": server.URL}}, Delivery{Recipient: Recipient{Kind: "self"}})
	if result.Retryable || !result.BlockAccount || calls != 1 {
		t.Fatal("restricted account blindly retried", result)
	}
	result = m.send(context.Background(), Channel{Type: "webhook", Config: map[string]string{"url": "http://127.0.0.1:1"}}, Delivery{})
	if !result.Retryable || result.Status != "failed" {
		t.Fatal("connection failure should retry safely", result)
	}
}

func TestSilenceSuppressesQueuedTasksWithoutReplayingHistory(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://localhost/hook")
	r.ForSeconds = 0
	_ = json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	now := time.Now()
	m.now = func() time.Time { return now }
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/alerts/rules/"+r.ID+"/silence", map[string]string{"until": stamp(now.Add(time.Hour))}, 200), &r)
	var status string
	_ = m.deps.DB.QueryRow("SELECT status FROM alert_outbox").Scan(&status)
	if status != "suppressed" {
		t.Fatal("old queued task escaped silence", status)
	}
	now = now.Add(time.Hour + time.Second)
	if e := m.Evaluate(context.Background(), r, now); e != nil {
		t.Fatal(e)
	}
	events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events ORDER BY rowid")
	if len(events) != 2 || events[0].Kind != "firing" || events[1].Kind != "reminder" {
		t.Fatal("silence replayed historical events", events)
	}
}

func TestSlowChannelDoesNotBlockOtherAccount(t *testing.T) {
	m, mux := testModule(t)
	release := make(chan struct{})
	arrived := make(chan struct{}, 1)
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
		w.WriteHeader(202)
	}))
	defer slow.Close()
	fast := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { arrived <- struct{}{}; w.WriteHeader(202) }))
	defer fast.Close()
	for _, endpoint := range []string{slow.URL, fast.URL} {
		var c Channel
		_ = json.Unmarshal(request(t, mux, "POST", "/api/v1/notify/channels", Channel{Name: endpoint, Type: "webhook", Enabled: true, Config: map[string]string{"url": endpoint}}, 200), &c)
		request(t, mux, "POST", "/api/v1/notify/channels/"+c.ID+"/test", map[string]any{"recipient": Recipient{Kind: "channel", Value: "bound"}}, 200)
	}
	done := make(chan error, 1)
	go func() { done <- m.SendPending(context.Background()) }()
	select {
	case <-arrived:
	case <-time.After(time.Second):
		close(release)
		<-done
		t.Fatal("slow channel blocked a separate account")
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}
