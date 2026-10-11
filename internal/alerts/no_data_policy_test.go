package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

func TestDelayedWindowAndNoDataPreview(t *testing.T) {
	for _, tc := range []struct {
		policy, value, health, status, wantValue string
	}{
		{"", "", "no_data", "normal", ""},
		{"keep_state", "", "no_data", "normal", ""},
		{"zero", "", "ok", "firing", "0"},
		{"value", "18446744073709551615", "ok", "normal", "18446744073709551615"},
		{"value", "0.000000000000000001", "ok", "firing", "0.000000000000000001"},
		{"alerting", "", "ok", "firing", ""},
		{"normal", "", "ok", "normal", ""},
	} {
		t.Run(tc.policy+tc.value, func(t *testing.T) {
			m, mux := testModule(t)
			r := seed(t, m, mux, "http://127.0.0.1:9999")
			r.Operator, r.Threshold = "lt", "10"
			r.WindowSeconds, r.DelaySeconds = 600, 120
			r.NoDataPolicy, r.NoDataValue = tc.policy, tc.value
			now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
			for _, nullRow := range []bool{false, true} {
				m.deps.Query = func(_ context.Context, req shared.QueryRequest) (shared.QueryResponse, error) {
					if req.Range.From != stamp(now.Add(-12*time.Minute)) || req.Range.To != stamp(now.Add(-2*time.Minute)) {
						t.Fatalf("delayed range: %+v", req.Range)
					}
					rows := [][]any{}
					if nullRow {
						rows = [][]any{{nil}}
					}
					return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "Nullable(Decimal(38,18))"}}, Rows: rows}}}}}, nil
				}
				p, err := m.inspect(context.Background(), r, now)
				if err != nil || len(p.States) != 1 {
					t.Fatalf("preview: %+v %v", p, err)
				}
				s := p.States[0]
				if s.Health != tc.health || s.Status != tc.status || s.Value != tc.wantValue {
					t.Fatalf("null=%v: %+v", nullRow, s)
				}
			}
			m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
				return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "value", Type: "UInt64"}}, Rows: [][]any{{"0"}}}}}}}, nil
			}
			p, err := m.inspect(context.Background(), r, now)
			if err != nil || p.States[0].Value != "0" || p.States[0].Health != "ok" || p.States[0].Status != "firing" || p.States[0].missing {
				t.Fatalf("real zero must not invoke missing policy: %+v %v", p, err)
			}
			m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
				return shared.QueryResponse{}, errors.New("unavailable")
			}
			p, err = m.inspect(context.Background(), r, now)
			if err != nil || p.States[0].Health != "error" || p.States[0].Value != "" {
				t.Fatalf("query error substituted: %+v %v", p, err)
			}
		})
	}
}

func TestMissingSeriesPolicyAndRecovery(t *testing.T) {
	for _, policy := range []string{"keep_state", "zero", "value", "alerting", "normal"} {
		t.Run(policy, func(t *testing.T) {
			m, mux := testModule(t)
			r := seed(t, m, mux, "http://127.0.0.1:9999")
			r.Operator, r.Threshold, r.ForSeconds, r.NotifyHealth = "lt", "10", 0, false
			r.LabelFields, r.SQL = []string{"service"}, "SELECT service, avg(value) AS value FROM metric_http_sum GROUP BY service"
			r.NoDataPolicy, r.NoDataValue = policy, "5"
			json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
			rows := [][]any{{"a", "20"}, {"b", "20"}}
			m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
				return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "service", Type: "String"}, {Name: "value", Type: "Nullable(UInt64)"}}, Rows: rows}}}}}, nil
			}
			now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
			evaluate := func() []State {
				t.Helper()
				if err := m.Evaluate(context.Background(), r, now); err != nil {
					t.Fatal(err)
				}
				now = now.Add(10 * time.Second)
				states, err := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
				if err != nil || len(states) != 2 {
					t.Fatalf("must retain two known series: %+v %v", states, err)
				}
				return states
			}
			evaluate()
			rows = [][]any{{"a", "20"}}
			wantFiring := policy == "zero" || policy == "value" || policy == "alerting"
			for _, s := range evaluate() {
				if s.Labels["service"] == "b" && s.LastSuccess != stamp(now.Add(-20*time.Second)) {
					t.Fatalf("substitution advanced last real data time: %+v", s)
				}
				if s.Labels["service"] == "a" && s.Status != "normal" || s.Labels["service"] == "b" && (s.Status == "firing") != wantFiring {
					t.Fatalf("per-series policy: %+v", s)
				}
			}
			rows = nil
			for _, s := range evaluate() {
				if (s.Status == "firing") != wantFiring {
					t.Fatalf("whole-query absence: %+v", s)
				}
			}
			rows = [][]any{{"a", "20"}, {"b", "20"}}
			for _, s := range evaluate() {
				if s.Status != "normal" || s.Health != "ok" || s.Episode != "" {
					t.Fatalf("recovery: %+v", s)
				}
			}
			// A missing value must preserve an existing firing episode by default,
			// while the explicit normal policy resolves it.
			rows = [][]any{{"a", "5"}, {"b", "5"}}
			evaluate()
			rows = nil
			for _, s := range evaluate() {
				if (s.Status == "firing") != (policy != "normal") {
					t.Fatalf("missing after firing: %+v", s)
				}
			}
		})
	}
}

func TestNoDataPolicyValidationAndPersistence(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	r.PanelCondition = &PanelCondition{PanelID: "panel", QueryRef: "A", Reducer: "sum"}
	r.NoDataPolicy, r.NoDataValue, r.DelaySeconds = "value", "18446744073709551615", 120
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	var saved []Rule
	json.Unmarshal(request(t, mux, "GET", "/api/v1/alerts/rules", nil, 200), &saved)
	if len(saved) != 1 || saved[0].NoDataValue != r.NoDataValue || saved[0].NoDataPolicy != "value" || saved[0].DelaySeconds != 120 || saved[0].PanelCondition.Reducer != "sum" {
		t.Fatalf("policy not persisted: %+v", saved)
	}
	for _, bad := range []string{"", "NaN", "Infinity", "invalid"} {
		r.NoDataValue = bad
		request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 400)
	}
	r.NoDataPolicy = "unknown"
	request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 400)
	r.NoDataPolicy, r.PanelCondition.Reducer = "normal", "invalid"
	request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 400)
	r.PanelCondition.Reducer = "count"
	request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200)
	// A rule explicitly watching for missing points ignores numeric substitution.
	r.Operator, r.Threshold = "no_data", "0"
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "empty", Complete: true}}}, nil
	}
	p, err := m.inspect(context.Background(), r, time.Now())
	if err != nil || p.States[0].Status != "firing" {
		t.Fatalf("explicit no-data operator overridden: %+v %v", p, err)
	}
}

func TestMissingPolicyHonorsDurationsAndRetiresInitialAbsence(t *testing.T) {
	m, mux := testModule(t)
	r := seed(t, m, mux, "http://127.0.0.1:9999")
	r.NoDataPolicy, r.ForSeconds, r.RecoverySeconds, r.NotifyHealth = "alerting", 20, 20, false
	r.LabelFields, r.SQL = []string{"service"}, "SELECT service, avg(value) AS value FROM metric_http_sum GROUP BY service"
	json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
	var rows [][]any
	m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
		return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "service", Type: "String"}, {Name: "value", Type: "Nullable(UInt64)"}}, Rows: rows}}}}}, nil
	}
	now := time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)
	for _, offset := range []time.Duration{0, 10 * time.Second, 20 * time.Second} {
		if err := m.Evaluate(context.Background(), r, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
		events, _ := listBodies[Event](context.Background(), m.deps.DB, "SELECT body FROM alert_events")
		want := 0
		if offset == 20*time.Second {
			want = 1
		}
		if len(events) != want {
			t.Fatalf("missing policy ignored for_seconds: %+v", events)
		}
	}
	// Real series arrive already breaching the threshold. Even these must retire
	// the anonymous whole-query absence instead of leaving a third alert behind.
	rows = [][]any{{"a", "20"}, {"b", "20"}}
	for _, offset := range []time.Duration{30 * time.Second, 40 * time.Second, 50 * time.Second} {
		if err := m.Evaluate(context.Background(), r, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
		states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
		want := 3
		if offset == 50*time.Second {
			want = 2
		}
		if len(states) != want {
			t.Fatalf("initial absence recovery duration/retirement: %+v", states)
		}
	}
	rows = [][]any{{"a", "0"}, {"b", "0"}}
	for _, offset := range []time.Duration{60 * time.Second, 70 * time.Second, 80 * time.Second} {
		if err := m.Evaluate(context.Background(), r, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
	for _, s := range states {
		if s.Status != "normal" || s.Episode != "" {
			t.Fatalf("real data did not recover: %+v", s)
		}
	}
}

func TestInitialAbsenceRetiresWhenNullSeriesAppear(t *testing.T) {
	for _, policy := range []string{"keep_state", "zero", "value", "alerting", "normal"} {
		t.Run(policy, func(t *testing.T) {
			m, mux := testModule(t)
			r := seed(t, m, mux, "http://127.0.0.1:9999")
			r.NoDataPolicy, r.NoDataValue, r.ForSeconds, r.NotifyHealth = policy, "20", 0, false
			r.LabelFields, r.SQL = []string{"service"}, "SELECT service, avg(value) AS value FROM metric_http_sum GROUP BY service"
			json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+r.ID, r, 200), &r)
			var rows [][]any
			m.deps.Query = func(context.Context, shared.QueryRequest) (shared.QueryResponse, error) {
				return shared.QueryResponse{Results: []shared.QueryResult{{Status: "success", Complete: true, Frames: []shared.Frame{{Columns: []shared.Column{{Name: "service", Type: "String"}, {Name: "value", Type: "Nullable(UInt64)"}}, Rows: rows}}}}}, nil
			}
			now := time.Now().UTC()
			if err := m.Evaluate(context.Background(), r, now); err != nil {
				t.Fatal(err)
			}
			rows = [][]any{{"a", nil}, {"b", nil}}
			if err := m.Evaluate(context.Background(), r, now.Add(10*time.Second)); err != nil {
				t.Fatal(err)
			}
			states, _ := listBodies[State](context.Background(), m.deps.DB, "SELECT body FROM alert_states")
			if len(states) != 2 {
				t.Fatalf("anonymous absence must retire even if new lines have no value: %+v", states)
			}
		})
	}
}
