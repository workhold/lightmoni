package assistant

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func usageInt(n int64) *int64       { return &n }
func usageFloat(n float64) *float64 { return &n }

func TestUsageRecordFromEventPreservesMissingCounts(t *testing.T) {
	tests := []struct {
		name string
		data map[string]any
		in   *int64
		out  *int64
		sum  *int64
	}{
		{"unknown request", nil, nil, nil, nil},
		{"known zero", map[string]any{"input_tokens": float64(0), "output_tokens": json.Number("0")}, usageInt(0), usageInt(0), usageInt(0)},
		{"integer total inferred", map[string]any{"input_tokens": int32(12), "output_tokens": uint64(8)}, usageInt(12), usageInt(8), usageInt(20)},
		{"one count missing", map[string]any{"input_tokens": json.Number("9007199254740993")}, usageInt(9007199254740993), nil, nil},
		{"explicit total", map[string]any{"total_tokens": int64(10)}, nil, nil, usageInt(10)},
		{"provider total preserved", map[string]any{"input_tokens": 12, "output_tokens": 8, "total_tokens": 30}, usageInt(12), usageInt(8), usageInt(30)},
		{"invalid values", map[string]any{"input_tokens": -1, "output_tokens": 1.5, "total_tokens": "5"}, nil, nil, nil},
		{"sum overflow remains unknown", map[string]any{"input_tokens": json.Number("9223372036854775807"), "output_tokens": 1}, usageInt(math.MaxInt64), usageInt(1), nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record, ok := usageRecordFromEvent(Event{SessionID: "session", TurnID: "turn", Sequence: 42, Type: "turn.usage", Timestamp: "2026-10-17T01:02:03Z", Data: test.data}, "assistant")
			if !ok || record.ID != "session/turn/42" || record.Source != "assistant" || record.Timestamp != "2026-10-17T01:02:03Z" {
				t.Fatalf("wrong event identity: %+v, %v", record, ok)
			}
			if !reflect.DeepEqual(record.InputTokens, test.in) || !reflect.DeepEqual(record.OutputTokens, test.out) || !reflect.DeepEqual(record.TotalTokens, test.sum) {
				t.Fatalf("got in=%v out=%v total=%v; record=%+v", record.InputTokens, record.OutputTokens, record.TotalTokens, record)
			}
			encoded, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err := json.Unmarshal(encoded, &fields); err != nil {
				t.Fatal(err)
			}
			if fields["input_tokens"] == nil && test.in != nil {
				t.Fatal("known zero was serialized as unknown")
			}
		})
	}
	if _, ok := usageRecordFromEvent(Event{Type: "step.completed"}, "assistant"); ok {
		t.Fatal("non-usage event became a request")
	}
	metadata, _ := usageRecordFromEvent(Event{Type: "turn.usage", Data: map[string]any{
		"phase": "compaction", "source": "assistant", "base_url": "https://provider.invalid/v1", "protocol": "openai-chat-completions", "model": "model-v1", "currency": "CNY", "estimated_cost": 0.12,
	}}, "fallback")
	if metadata.Phase != "compaction" || metadata.Source != "assistant" || metadata.Model != "model-v1" || metadata.BaseURL == "" || metadata.Protocol == "" || metadata.Currency != "CNY" || metadata.EstimatedCost == nil || *metadata.EstimatedCost != 0.12 {
		t.Fatalf("event snapshot lost: %+v", metadata)
	}
}

func TestUsageCountRejectsUnsafeNumbers(t *testing.T) {
	valid := []any{int(0), int8(1), int16(2), int32(3), int64(4), uint(5), uint8(6), uint16(7), uint32(8), uint64(9), float32(10), float64(11), json.Number("12.0"), json.Number("1e3"), json.Number("9223372036854775807")}
	for _, value := range valid {
		if count := usageCount(value); count == nil || *count < 0 {
			t.Errorf("rejected valid count %#v (%T)", value, value)
		}
	}
	invalid := []any{nil, true, "12", -1, int64(-1), float64(-1), 0.5, math.NaN(), math.Inf(1), float64(math.MaxInt64), uint64(math.MaxUint64), json.Number("-1"), json.Number("1.2"), json.Number("9223372036854775808"), json.Number("NaN"), json.Number("true")}
	for _, value := range invalid {
		if count := usageCount(value); count != nil {
			t.Errorf("accepted invalid count %#v (%T): %d", value, value, *count)
		}
	}
}

func TestUsageReportAllUsersUnknownsCurrenciesAndIdentity(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 17, 14, 0, 0, 0, location)
	rows := []UsageRecord{
		{ID: "before", Timestamp: "2026-10-10T15:59:59.999999999Z", Source: "assistant", InputTokens: usageInt(999)},
		{ID: "alice", UserID: "alice", Timestamp: "2026-10-10T16:00:00Z", Source: "assistant", BaseURL: "https://a.invalid/v1", Protocol: "openai-chat-completions", Model: "shared", InputTokens: usageInt(10), OutputTokens: usageInt(5), TotalTokens: usageInt(15), Currency: "CNY", EstimatedCost: usageFloat(0.15)},
		{ID: "bob", UserID: "bob", Timestamp: "2026-10-16T16:00:00Z", Source: "assistant", BaseURL: "https://b.invalid/v1", Protocol: "openai-chat-completions", Model: "shared", InputTokens: usageInt(0), Currency: "USD", EstimatedCost: usageFloat(0)},
		{ID: "test", UserID: "admin", Timestamp: "2026-10-17T15:59:59.999999999Z", Source: "connection_test", BaseURL: "https://a.invalid/v1", Protocol: "openai-responses", Model: "shared", OutputTokens: usageInt(2), Currency: "CNY", EstimatedCost: usageFloat(0.05)},
		{ID: "unknown", Timestamp: "2026-10-17T01:00:00Z", Source: "assistant"},
		{ID: "after", Timestamp: "2026-10-17T16:00:00Z", Source: "assistant", InputTokens: usageInt(999)},
		{ID: "invalid", Timestamp: "garbage", Source: "assistant", InputTokens: usageInt(999)},
	}
	report := buildUsageReport(rows, at, 7, location)
	if report.From != "2026-10-10T16:00:00Z" || report.To != "2026-10-17T16:00:00Z" || report.Timezone != "Asia/Shanghai" || len(report.Daily) != 7 {
		t.Fatalf("wrong local day window: %+v", report)
	}
	want := UsageStats{Requests: 4, UnknownStatusRequests: 4, InputTokens: 10, OutputTokens: 7, TotalTokens: 15, InputMissing: 2, OutputMissing: 2, TotalMissing: 3, UnpricedRequests: 1, EstimatedCosts: []UsageCost{{Currency: "CNY", Amount: 0.2, Requests: 2}, {Currency: "USD", Amount: 0, Requests: 1}}}
	if !reflect.DeepEqual(report.Totals, want) {
		t.Fatalf("totals=%+v, want=%+v", report.Totals, want)
	}
	if report.Daily[0].Date != "2026-10-11" || report.Daily[0].Requests != 1 || report.Daily[6].Date != "2026-10-17" || report.Daily[6].Requests != 3 || report.Daily[1].Requests != 0 || report.Daily[1].EstimatedCosts == nil {
		t.Fatalf("daily buckets incorrect: %+v", report.Daily)
	}
	if len(report.Models) != 4 {
		t.Fatalf("models with different URL/protocol were merged: %+v", report.Models)
	}
	if len(report.Sources) != 2 || report.Sources[0].Source != "assistant" || report.Sources[0].Requests != 3 || report.Sources[1].Source != "connection_test" || report.Sources[1].Requests != 1 {
		t.Fatalf("sources=%+v", report.Sources)
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var decoded UsageReport
	if err := json.Unmarshal(encoded, &decoded); err != nil || !reflect.DeepEqual(decoded, report) {
		t.Fatalf("report does not roundtrip: %s %v", encoded, err)
	}
}

func usageLifecycleStores(t *testing.T) map[string]func(*testing.T) UsageStore {
	return map[string]func(*testing.T) UsageStore{
		"memory": func(*testing.T) UsageStore { return NewMemoryStore() },
		"sqlite": func(t *testing.T) UsageStore {
			db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "lifecycle.db"))
			if err != nil {
				t.Fatal(err)
			}
			db.SetMaxOpenConns(1)
			t.Cleanup(func() { db.Close() })
			store, err := NewSQLiteStore(db)
			if err != nil {
				t.Fatal(err)
			}
			return store
		},
	}
}

func TestUsageLifecyclePendingTerminalSnapshotAndFallback(t *testing.T) {
	for name, factory := range usageLifecycleStores(t) {
		t.Run(name, func(t *testing.T) {
			store := factory(t)
			s := &Service{options: Options{Store: store.(Store)}}
			in, out := 2.0, 8.0
			billing := Billing{BaseURL: "https://fixture.invalid/v1", Protocol: ProtocolOpenAIChat, Model: "start-model", Currency: "CNY", InputPricePerMillion: &in, OutputPricePerMillion: &out}
			recorder := newUsageRecorder(s, "assistant", "alice", "session", "turn", billing)
			start := Event{Sequence: 1, Type: "model.request.started", Timestamp: "2026-10-17T00:00:00Z", Data: map[string]any{"request_id": "request-1", "phase": "execute", "input_tokens": 999, "estimated_cost": 999}}
			if err := recorder.record(start); err != nil {
				t.Fatal(err)
			}
			rows, err := store.ListUsage(context.Background(), "", "")
			if err != nil || len(rows) != 1 {
				t.Fatalf("start: %+v %v", rows, err)
			}
			if rows[0].Status != UsagePending || rows[0].InputTokens != nil || rows[0].EstimatedCost != nil || *rows[0].InputPricePerMillion != 2 {
				t.Fatalf("pending invented usage or lost rates: %+v", rows[0])
			}
			// Mutating the caller's pricing data cannot change a started request.
			in = 100
			out = 100
			terminal := Event{Sequence: 99, Type: "turn.usage", Timestamp: "2026-10-17T00:00:05Z", Data: map[string]any{"request_id": "request-1", "status": "failed", "input_tokens": 1000000, "phase": "execute", "source": "injected", "estimated_cost": 999, "currency": "USD", "model": "injected"}}
			if err := recorder.record(terminal); err != nil {
				t.Fatal(err)
			}
			terminal.Data["status"] = UsageSucceeded
			terminal.Data["output_tokens"] = 1000000
			if err := recorder.record(terminal); err != nil {
				t.Fatal(err)
			}
			// Replay from a distinct recorder with a newer price is also immutable.
			newRecorder := newUsageRecorder(s, "assistant", "alice", "session", "turn", billing)
			if err := newRecorder.record(terminal); err != nil {
				t.Fatal(err)
			}
			rows, err = store.ListUsage(context.Background(), "", "")
			if err != nil || len(rows) != 1 {
				t.Fatal(rows, err)
			}
			first := rows[0]
			if first.ID != "session/turn/request/request-1" || first.RequestID != "request-1" || first.Status != UsageFailed || first.Timestamp != start.Timestamp || first.CompletedAt != "2026-10-17T00:00:05Z" || first.CostStatus != CostPartial || first.EstimatedCost == nil || *first.EstimatedCost != 2 || first.OutputTokens != nil || first.InputEstimatedCost == nil || *first.InputEstimatedCost != 2 || first.OutputEstimatedCost != nil || *first.InputPricePerMillion != 2 || first.Currency != "CNY" || first.Source != "assistant" || first.Model != "start-model" {
				t.Fatalf("partial snapshot/replay: %+v", first)
			}
			// The host closes requests left pending by an abruptly terminated worker.
			for _, status := range []string{UsageFailed, UsageCancelled} {
				r := newUsageRecorder(s, "connection-test", "admin", "", "test-"+status, billing)
				if err := r.record(Event{Type: "model.request.started", Timestamp: start.Timestamp, Data: map[string]any{"request_id": "pending"}}); err != nil {
					t.Fatal(err)
				}
				if err := r.finish(status); err != nil {
					t.Fatal(err)
				}
				if err := r.finish(status); err != nil {
					t.Fatal(err)
				}
			}
			rows, err = store.ListUsage(context.Background(), "", "")
			if err != nil || len(rows) != 3 {
				t.Fatal(rows, err)
			}
			for _, row := range rows {
				if row.RequestID == "pending" && (row.Status == UsagePending || row.InputTokens != nil || row.OutputTokens != nil || row.EstimatedCost != nil || row.CompletedAt == "") {
					t.Fatalf("fallback fabricated usage: %+v", row)
				}
			}
			report := buildUsageReport(rows, time.Date(2026, 10, 17, 1, 0, 0, 0, time.UTC), 7, time.UTC)
			if report.Totals.Requests != 3 || report.Totals.FailedRequests != 2 || report.Totals.CancelledRequests != 1 || report.Totals.PartialPricedRequests != 1 || report.Totals.UnpricedRequests != 2 || len(report.Totals.EstimatedCosts) != 1 || report.Totals.EstimatedCosts[0].Requests != 0 || report.Totals.EstimatedCosts[0].PartialRequests != 1 || report.Totals.EstimatedCosts[0].Amount != 2 {
				t.Fatalf("lifecycle totals: %+v", report.Totals)
			}
		})
	}
}

func TestUsageStoreConcurrentFinalizationKeepsOriginalRates(t *testing.T) {
	for name, factory := range usageLifecycleStores(t) {
		t.Run(name, func(t *testing.T) {
			store := factory(t)
			ctx := context.Background()
			pending := UsageRecord{ID: "session/turn/request/concurrent", RequestID: "concurrent", Timestamp: "2026-10-17T00:00:00Z", Status: UsagePending, Source: "assistant", Currency: "CNY", InputPricePerMillion: usageFloat(2), OutputPricePerMillion: usageFloat(8)}
			if err := store.RecordUsage(ctx, pending); err != nil {
				t.Fatal(err)
			}
			var group sync.WaitGroup
			for i := 0; i < 20; i++ {
				group.Add(1)
				go func(i int) {
					defer group.Done()
					incoming := pending
					incoming.Status = UsageSucceeded
					if i%2 == 0 {
						incoming.Status = UsageFailed
					}
					incoming.Timestamp = "2026-10-17T00:01:00Z"
					incoming.InputTokens = usageInt(1000000)
					incoming.OutputTokens = usageInt(500000)
					incoming.InputPricePerMillion = usageFloat(999)
					incoming.OutputPricePerMillion = usageFloat(999)
					if err := store.RecordUsage(ctx, incoming); err != nil {
						t.Error(err)
					}
				}(i)
			}
			group.Wait()
			rows, err := store.ListUsage(ctx, "", "")
			if err != nil || len(rows) != 1 {
				t.Fatal(rows, err)
			}
			row := rows[0]
			if !terminalUsageStatus(row.Status) || row.CostStatus != CostComplete || row.EstimatedCost == nil || *row.EstimatedCost != 6 || *row.InputPricePerMillion != 2 || *row.OutputPricePerMillion != 8 || row.Timestamp != pending.Timestamp {
				t.Fatalf("concurrent finalization changed snapshot: %+v", row)
			}
		})
	}
}

func TestUsageRequestIDNormalizationAndLegacyCompatibility(t *testing.T) {
	legacy, _ := usageRecordFromEvent(Event{Type: "turn.usage", SessionID: "s", TurnID: "t", Sequence: 7, Data: map[string]any{"estimated_cost": 0.5, "currency": "USD"}}, "assistant")
	if legacy.ID != "s/t/7" || legacy.Status != "" || legacy.CostStatus != CostLegacy || legacy.InputPricePerMillion != nil {
		t.Fatalf("legacy rewritten: %+v", legacy)
	}
	for _, sequence := range []int64{0, 99} {
		row, _ := usageRecordFromEvent(Event{Type: "turn.usage", SessionID: "s", TurnID: "t", Sequence: sequence, Data: map[string]any{"request_id": "stable", "status": UsageSucceeded}}, "assistant")
		if row.ID != "s/t/request/stable" || row.RequestID != "stable" || row.Status != UsageSucceeded {
			t.Fatal(row)
		}
	}
	rows := []UsageRecord{{ID: "a", Timestamp: "2026-10-17T00:00:00Z", Status: UsagePending}, {ID: "b", Timestamp: "2026-10-17T00:00:00Z", Status: UsageSucceeded, EstimatedCost: usageFloat(1), Currency: "CNY", CostStatus: CostComplete}, {ID: "c", Timestamp: "2026-10-17T00:00:00Z", Status: UsageFailed, EstimatedCost: usageFloat(0.5), Currency: "USD", CostStatus: CostPartial}, {ID: "d", Timestamp: "2026-10-17T00:00:00Z", EstimatedCost: usageFloat(2), Currency: "USD"}, {ID: "e", Timestamp: "2026-10-17T00:00:00Z", Status: UsageCancelled}}
	report := buildUsageReport(rows, time.Date(2026, 10, 17, 1, 0, 0, 0, time.UTC), 7, time.UTC)
	got := report.Totals
	if got.Requests != 5 || got.SucceededRequests != 1 || got.FailedRequests != 1 || got.CancelledRequests != 1 || got.PendingRequests != 1 || got.UnknownStatusRequests != 1 || got.PartialPricedRequests != 1 || got.UnpricedRequests != 2 || len(got.EstimatedCosts) != 2 || got.EstimatedCosts[1].Amount != 2.5 || got.EstimatedCosts[1].Requests != 1 || got.EstimatedCosts[1].PartialRequests != 1 {
		t.Fatalf("mixed legacy/status/currency totals: %+v", got)
	}
}

func TestUsageLifecycleRejectsInvalidIdentityAndIgnoresReplay(t *testing.T) {
	s, _ := fixtureService(t, nil)
	recorder := newUsageRecorder(s, "assistant", "alice", "s", "t", Billing{Currency: "CNY"})
	for _, event := range []Event{
		{Type: "model.request.started"},
		{Type: "model.request.started", Data: map[string]any{"request_id": "../injected"}},
		{Type: "turn.usage", Data: map[string]any{"request_id": "valid", "status": "pending"}},
		{Type: "turn.usage", Data: map[string]any{"request_id": "valid", "status": "free"}},
	} {
		if err := recorder.record(event); err == nil {
			t.Fatalf("accepted invalid lifecycle event: %+v", event)
		}
	}
	start := Event{Type: "model.request.started", Timestamp: "2026-10-17T00:00:00Z", Data: map[string]any{"request_id": "stable", "phase": "execute"}}
	if err := recorder.record(start); err != nil {
		t.Fatal(err)
	}
	start.Timestamp = "2026-10-18T00:00:00Z"
	if err := recorder.record(start); err != nil {
		t.Fatal(err)
	}
	if err := recorder.finish(UsageSucceeded); err == nil {
		t.Fatal("host fallback invented success")
	}
	if err := recorder.finish(UsageCancelled); err != nil {
		t.Fatal(err)
	}
	if err := recorder.record(start); err != nil {
		t.Fatal(err)
	}
	rows, err := s.options.Store.(UsageStore).ListUsage(context.Background(), "", "")
	if err != nil || len(rows) != 1 || rows[0].Timestamp != "2026-10-17T00:00:00Z" || rows[0].Status != UsageCancelled {
		t.Fatalf("replay changed durable request: %+v %v", rows, err)
	}
}

func TestUsageLifecycleServiceFailedAndCancelled(t *testing.T) {
	for _, mode := range []string{UsageFailed, UsageCancelled} {
		t.Run(mode, func(t *testing.T) {
			s, server := fixtureService(t, nil)
			cfg := Config{BaseURL: "https://fixture.invalid/v1", Protocol: ProtocolOpenAIChat, Model: "fixture", Enabled: true}
			encoded, _ := json.Marshal(cfg)
			if err := s.options.Store.Put(context.Background(), "config", encoded); err != nil {
				t.Fatal(err)
			}
			session := createSession(t, server)
			requestContext, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.options.Runtime = usageFixtureRuntime(func(ctx context.Context, _ RuntimeInput, emit func(RuntimeFrame) error) error {
				if err := emit(RuntimeFrame{Type: "event", Name: "model.request.started", Data: map[string]any{"request_id": "native-request", "phase": "execute"}}); err != nil {
					return err
				}
				rows, err := s.options.Store.(UsageStore).ListUsage(context.Background(), "", "")
				if err != nil || len(rows) != 1 || rows[0].Status != UsagePending {
					t.Fatalf("start not durable before provider work: %+v %v", rows, err)
				}
				if mode == UsageCancelled {
					cancel()
					return ctx.Err()
				}
				return errors.New("provider failed before usage")
			})
			req := httptest.NewRequest(http.MethodPost, "/api/v1/assistant/sessions/"+session.ID+"/turns", strings.NewReader(`{"text":"fixture"}`)).WithContext(requestContext)
			req.SetPathValue("id", session.ID)
			recorder := httptest.NewRecorder()
			s.turn(recorder, req)
			rows, err := s.options.Store.(UsageStore).ListUsage(context.Background(), "", "")
			if err != nil || len(rows) != 1 {
				t.Fatal(rows, err)
			}
			if rows[0].Status != mode || rows[0].InputTokens != nil || rows[0].OutputTokens != nil || rows[0].EstimatedCost != nil || rows[0].CompletedAt == "" {
				t.Fatalf("host fallback lost request: %+v", rows[0])
			}
		})
	}
}

func TestUsageSQLitePendingFinalizationBackfill(t *testing.T) {
	store := usageLifecycleStores(t)["sqlite"](t).(*SQLiteStore)
	pending := UsageRecord{ID: "s/t/request/stable", RequestID: "stable", Status: UsagePending, Timestamp: "2026-10-17T00:00:00Z", Currency: "CNY", Model: "original", InputPricePerMillion: usageFloat(2), OutputPricePerMillion: usageFloat(8)}
	if err := store.RecordUsage(context.Background(), pending); err != nil {
		t.Fatal(err)
	}
	session := Session{ID: "s", UserID: "alice", UpdatedAt: "2026-10-17T00:00:10Z", Events: []Event{{Type: "turn.usage", Sequence: 9, SessionID: "s", TurnID: "t", Timestamp: "2026-10-17T00:00:10Z", Data: map[string]any{"request_id": "stable", "status": UsageSucceeded, "input_tokens": 1000000, "output_tokens": 500000}}}}
	encoded, _ := json.Marshal(session)
	if err := store.Put(context.Background(), "session/alice/s", encoded); err != nil {
		t.Fatal(err)
	}
	if _, err := NewSQLiteStore(store.db); err != nil {
		t.Fatal(err)
	}
	rows, err := store.ListUsage(context.Background(), "", "")
	if err != nil || len(rows) != 1 {
		t.Fatal(rows, err)
	}
	if rows[0].Status != UsageSucceeded || rows[0].Model != "original" || rows[0].EstimatedCost == nil || *rows[0].EstimatedCost != 6 || rows[0].Timestamp != pending.Timestamp || rows[0].CompletedAt != "2026-10-17T00:00:10Z" {
		t.Fatalf("backfill duplicated or repriced stable request: %+v", rows[0])
	}
}

func TestUsageSQLiteRecoversInterruptedRequestsAfterRestart(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "restart-usage.db")
	openStore := func() (*sql.DB, *SQLiteStore) {
		db, err := sql.Open("sqlite", filename)
		if err != nil {
			t.Fatal(err)
		}
		db.SetMaxOpenConns(1)
		store, err := NewSQLiteStore(db)
		if err != nil {
			db.Close()
			t.Fatal(err)
		}
		return db, store
	}
	db, store := openStore()
	unknown := UsageRecord{ID: "s/t/request/unknown", RequestID: "unknown", Status: UsagePending, Timestamp: "2026-10-17T00:00:00Z", BaseURL: "https://fixture.invalid/v1", Protocol: ProtocolOpenAIChat, Model: "original", Currency: "CNY", InputPricePerMillion: usageFloat(2), OutputPricePerMillion: usageFloat(8), CostStatus: CostUnpriced}
	known := unknown
	known.ID, known.RequestID = "s/t/request/known", "known"
	known.InputTokens = usageInt(1000000)
	applyUsagePricing(&known, Billing{InputPricePerMillion: known.InputPricePerMillion, OutputPricePerMillion: known.OutputPricePerMillion})
	complete := UsageRecord{ID: "s/t/request/complete", RequestID: "complete", Status: UsageSucceeded, Timestamp: "2026-10-17T00:00:00Z", CompletedAt: "2026-10-17T00:00:02Z", InputTokens: usageInt(1), OutputTokens: usageInt(2), Currency: "USD", EstimatedCost: usageFloat(0.25)}
	for _, row := range []UsageRecord{unknown, known, complete} {
		if err := store.RecordUsage(context.Background(), row); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, store = openStore()
	defer db.Close()
	rows, err := store.ListUsage(context.Background(), "", "")
	if err != nil || len(rows) != 3 {
		t.Fatal(rows, err)
	}
	byID := map[string]UsageRecord{}
	for _, row := range rows {
		byID[row.RequestID] = row
	}
	interrupted := byID["unknown"]
	if interrupted.Status != UsageFailed || interrupted.FailureReason != "service_interrupted" || interrupted.CompletedAt == "" || interrupted.Timestamp != unknown.Timestamp || interrupted.InputTokens != nil || interrupted.OutputTokens != nil || interrupted.TotalTokens != nil || interrupted.EstimatedCost != nil || interrupted.Model != "original" || *interrupted.InputPricePerMillion != 2 {
		t.Fatalf("restart guessed consumption or lost interruption: %+v", interrupted)
	}
	partial := byID["known"]
	if partial.Status != UsageFailed || partial.CostStatus != CostPartial || partial.FailureReason != "service_interrupted" || partial.EstimatedCost == nil || *partial.EstimatedCost != 2 || partial.OutputTokens != nil {
		t.Fatalf("restart lost known partial consumption: %+v", partial)
	}
	if !reflect.DeepEqual(byID["complete"], complete) {
		t.Fatalf("restart changed terminal pricing/status: %+v", byID["complete"])
	}
	first, _ := json.Marshal(rows)
	if _, err := NewSQLiteStore(db); err != nil {
		t.Fatal(err)
	}
	rows, err = store.ListUsage(context.Background(), "", "")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := json.Marshal(rows)
	if string(first) != string(again) {
		t.Fatal("second startup changed recovered records")
	}
}

func TestUsageDetailsBoundedAuditableAndAdminOnly(t *testing.T) {
	for name, factory := range usageLifecycleStores(t) {
		t.Run(name, func(t *testing.T) {
			s, server := fixtureService(t, nil)
			s.options.Store = factory(t).(Store)
			store := s.options.Store.(UsageStore)
			for i := 0; i < 105; i++ {
				row := UsageRecord{ID: fmt.Sprintf("detail-%03d", i), Timestamp: time.Now().Add(-time.Duration(i) * time.Minute).UTC().Format(time.RFC3339Nano), Status: UsageSucceeded, Currency: "CNY", InputTokens: usageInt(1000000), OutputTokens: usageInt(500000)}
				applyUsagePricing(&row, Billing{InputPricePerMillion: usageFloat(2), OutputPricePerMillion: usageFloat(8)})
				if err := store.RecordUsage(context.Background(), row); err != nil {
					t.Fatal(err)
				}
			}
			status, raw := request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/usage/details?limit=2&timezone=Asia%2FShanghai", "")
			var response struct {
				Records []UsageRecord `json:"records"`
				Limit   int           `json:"limit"`
				HasMore bool          `json:"has_more"`
			}
			if status != 200 || json.Unmarshal(raw, &response) != nil || len(response.Records) != 2 || !response.HasMore || response.Limit != 2 || response.Records[0].ID != "detail-000" || response.Records[1].ID != "detail-001" || response.Records[0].InputPricePerMillion == nil || *response.Records[0].InputPricePerMillion != 2 || *response.Records[0].InputEstimatedCost != 2 || *response.Records[0].OutputEstimatedCost != 4 {
				t.Fatalf("audit details: %d %s", status, raw)
			}
			status, raw = request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/usage/details", "")
			if json.Unmarshal(raw, &response) != nil || status != 200 || len(response.Records) != 100 || !response.HasMore {
				t.Fatalf("default limit not bounded: %d %s", status, raw)
			}
			for _, query := range []string{"limit=0", "limit=101", "limit=bad", "days=1", "timezone=bad"} {
				status, _ := request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/usage/details?"+query, "")
				if status != 400 {
					t.Fatalf("accepted invalid query %q: %d", query, status)
				}
			}
			req, _ := http.NewRequest(http.MethodGet, server.URL+"/api/v1/assistant/usage/details", nil)
			req.Header.Set("X-Member", "1")
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != 403 {
				t.Fatalf("member saw audit details: %d", resp.StatusCode)
			}
		})
	}
}

func TestUsageWindowUsesCalendarDaysAcrossDST(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 3, 9, 15, 0, 0, 0, location)
	from, to := usageWindow(at, 7, location)
	if from.Format(time.RFC3339) != "2026-03-03T00:00:00-05:00" || to.Format(time.RFC3339) != "2026-03-10T00:00:00-04:00" || to.Sub(from) != 167*time.Hour {
		t.Fatalf("DST window used fixed 24-hour days: %v to %v (%s)", from, to, to.Sub(from))
	}
	report := buildUsageReport(nil, at, 7, location)
	if len(report.Daily) != 7 || report.Daily[6].Date != "2026-03-09" {
		t.Fatalf("DST missing a calendar day: %+v", report.Daily)
	}
}

func TestUsageStoreContract(t *testing.T) {
	factories := map[string]func(*testing.T) UsageStore{
		"memory": func(*testing.T) UsageStore { return &MemoryStore{} },
		"sqlite": func(t *testing.T) UsageStore {
			db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "usage.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { db.Close() })
			db.SetMaxOpenConns(1)
			store, err := NewSQLiteStore(db)
			if err != nil {
				t.Fatal(err)
			}
			return store
		},
	}
	for name, factory := range factories {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			store := factory(t)
			record := UsageRecord{ID: "one", Timestamp: "2026-10-17T08:00:00.5+08:00", InputTokens: usageInt(0), OutputTokens: usageInt(4), TotalTokens: usageInt(4), Currency: "CNY", EstimatedCost: usageFloat(0)}
			if err := store.RecordUsage(ctx, record); err != nil {
				t.Fatal(err)
			}
			*record.InputTokens = 999
			*record.OutputTokens = 999
			*record.TotalTokens = 999
			*record.EstimatedCost = 999
			if err := store.RecordUsage(ctx, record); err != nil {
				t.Fatal(err)
			}
			for _, row := range []UsageRecord{{ID: "zero", Timestamp: "2026-10-17T00:00:00Z"}, {ID: "next", Timestamp: "2026-10-17T00:00:01Z"}, {ID: "nano", Timestamp: "2026-10-17T00:00:00.500000001Z"}} {
				if err := store.RecordUsage(ctx, row); err != nil {
					t.Fatal(err)
				}
			}
			rows, err := store.ListUsage(ctx, "2026-10-17T00:00:00.5Z", "2026-10-17T00:00:01Z")
			if err != nil || len(rows) != 2 || rows[0].ID != "one" || rows[1].ID != "nano" {
				t.Fatalf("fractional range query: %+v %v", rows, err)
			}
			if rows[0].Timestamp != "2026-10-17T00:00:00.5Z" || rows[0].InputTokens == nil || *rows[0].InputTokens != 0 || *rows[0].OutputTokens != 4 || *rows[0].TotalTokens != 4 || *rows[0].EstimatedCost != 0 {
				t.Fatalf("record not immutable/idempotent: %+v", rows[0])
			}
			*rows[0].InputTokens = 100
			*rows[0].OutputTokens = 100
			*rows[0].TotalTokens = 100
			*rows[0].EstimatedCost = 100
			again, err := store.ListUsage(ctx, "", "")
			if err != nil || len(again) != 4 || again[0].ID != "zero" || again[1].ID != "one" || *again[1].InputTokens != 0 || *again[1].OutputTokens != 4 || *again[1].TotalTokens != 4 || *again[1].EstimatedCost != 0 || again[0].InputTokens != nil {
				t.Fatalf("mutable or missing ledger rows: %+v %v", again, err)
			}
			for _, bounds := range [][2]string{{"invalid", ""}, {"", "invalid"}, {"2026-10-18T00:00:00Z", "2026-10-17T00:00:00Z"}} {
				if _, err := store.ListUsage(ctx, bounds[0], bounds[1]); err == nil {
					t.Fatalf("accepted invalid bounds: %v", bounds)
				}
			}
			for _, invalid := range []UsageRecord{{ID: "", Timestamp: record.Timestamp}, {ID: "bad", Timestamp: "bad"}} {
				if err := store.RecordUsage(ctx, invalid); err == nil {
					t.Fatalf("accepted invalid record: %+v", invalid)
				}
			}
		})
	}
}

func TestUsageSQLiteBackfillsAllSessionsAndSurvivesPruning(t *testing.T) {
	ctx := context.Background()
	filename := filepath.Join(t.TempDir(), "usage.db")
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE assistant_records(id TEXT PRIMARY KEY,value BLOB NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 205; i++ {
		session := Session{ID: fmt.Sprintf("session-%03d", i), UserID: fmt.Sprintf("user-%d", i%2), CreatedAt: "2026-10-17T00:00:00Z", UpdatedAt: "2026-10-17T01:00:00Z", Events: []Event{
			{Sequence: 1, TurnID: "turn", Type: "turn.started"},
			{Sequence: 2, TurnID: "turn", Type: "turn.usage", Data: map[string]any{"input_tokens": json.Number("9007199254740993"), "phase": "generation"}},
		}}
		if i == 204 {
			session.Events[1].Data = map[string]any{"input_tokens": 0, "output_tokens": 1, "base_url": "https://snapshot.invalid/v1", "protocol": "openai-responses", "model": "historical", "currency": "USD", "estimated_cost": 0.25}
		}
		encoded, err := json.Marshal(session)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO assistant_records(id,value) VALUES(?,?)`, sessionKey(Principal{ID: session.UserID}, session.ID), encoded); err != nil {
			t.Fatal(err)
		}
	}
	store, err := NewSQLiteStore(db)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := store.ListUsage(ctx, "", "")
	if err != nil || len(rows) != 205 {
		t.Fatalf("backfill stopped at session list limit: %d %v", len(rows), err)
	}
	if rows[0].ID != "session-000/turn/2" || rows[0].UserID != "user-0" || rows[0].SessionID != "session-000" || rows[0].Timestamp != "2026-10-17T01:00:00Z" || rows[0].Model != "" || rows[0].Protocol != "" || rows[0].EstimatedCost != nil || *rows[0].InputTokens != 9007199254740993 {
		t.Fatalf("legacy event was guessed or lost precision: %+v", rows[0])
	}
	last := rows[204]
	if last.Model != "historical" || last.Protocol != "openai-responses" || last.BaseURL != "https://snapshot.invalid/v1" || last.EstimatedCost == nil || *last.EstimatedCost != 0.25 || last.TotalTokens == nil || *last.TotalTokens != 1 {
		t.Fatalf("new snapshot not preserved on replay: %+v", last)
	}
	duplicate, _ := usageRecordFromEvent(Event{SessionID: "session-000", TurnID: "turn", Sequence: 2, Type: "turn.usage", Timestamp: rows[0].Timestamp, Data: map[string]any{"input_tokens": 1}}, "assistant")
	if err := store.RecordUsage(ctx, duplicate); err != nil {
		t.Fatal(err)
	}
	// Reinitializing while legacy sessions remain must not double count them.
	if _, err := NewSQLiteStore(db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM assistant_records WHERE substr(id,1,8)='session/'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = sql.Open("sqlite", filename)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store, err = NewSQLiteStore(db)
	if err != nil {
		t.Fatal(err)
	}
	rows, err = store.ListUsage(ctx, "", "")
	if err != nil || len(rows) != 205 || *rows[0].InputTokens != 9007199254740993 {
		t.Fatalf("ledger lost data after session pruning/restart: %d %v", len(rows), err)
	}
}

func TestUsageHandlerAdminAndValidation(t *testing.T) {
	s, server := fixtureService(t, nil)
	store := s.options.Store.(UsageStore)
	for i, user := range []string{"alice", "bob"} {
		if err := store.RecordUsage(context.Background(), UsageRecord{ID: fmt.Sprintf("request-%d", i), UserID: user, Timestamp: now(), Source: "assistant"}); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the handler directly so its contract remains covered separately
	// from service route registration, which is integrated by the host.
	for _, query := range []string{"", "?days=7&timezone=Asia%2FShanghai", "?days=90"} {
		response := httptest.NewRecorder()
		s.usage(response, httptest.NewRequest(http.MethodGet, "/api/v1/assistant/usage"+query, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("query %q: %d %s", query, response.Code, response.Body.String())
		}
		var report UsageReport
		if err := json.Unmarshal(response.Body.Bytes(), &report); err != nil || report.Totals.Requests != 2 || report.Totals.UnpricedRequests != 2 || len(report.Daily) != report.Days {
			t.Fatalf("admin statistics: %+v %v", report, err)
		}
		if query == "" && (report.Days != 30 || report.Timezone != "UTC") {
			t.Fatalf("wrong defaults: %+v", report)
		}
	}
	for _, query := range []string{"?days=1", "?days=invalid", "?days=0", "?timezone=invalid-zone", "?timezone=Local"} {
		response := httptest.NewRecorder()
		s.usage(response, httptest.NewRequest(http.MethodGet, "/api/v1/assistant/usage"+query, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("accepted bad query %q: %d", query, response.Code)
		}
	}
	response := httptest.NewRecorder()
	member := httptest.NewRequest(http.MethodGet, "/api/v1/assistant/usage", nil)
	member.Header.Set("X-Member", "1")
	s.usage(response, member)
	if response.Code != http.StatusForbidden {
		t.Fatalf("member accessed all users' usage: %d %s", response.Code, response.Body.String())
	}
	status, body := request(t, server.Client(), http.MethodGet, server.URL+"/api/v1/assistant/usage", "")
	if status != http.StatusOK {
		t.Fatalf("usage route unavailable: %d %s", status, body)
	}
}
