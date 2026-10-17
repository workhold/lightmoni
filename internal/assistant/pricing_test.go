package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"reflect"
	"testing"
	"time"
)

type usageFixtureRuntime func(context.Context, RuntimeInput, func(RuntimeFrame) error) error

func (f usageFixtureRuntime) Run(ctx context.Context, input RuntimeInput, _ func(context.Context, string, json.RawMessage) (any, error), emit func(RuntimeFrame) error) error {
	return f(ctx, input, emit)
}

func billingRequest(t *testing.T, serverURL, method string, b Billing) (int, Billing) {
	t.Helper()
	body, _ := json.Marshal(b)
	status, raw := request(t, http.DefaultClient, method, serverURL+"/api/v1/assistant/billing", string(body))
	var got Billing
	if status == http.StatusOK {
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
	}
	return status, got
}

func TestModelBillingIdentityUnknownFreeAndAuthorization(t *testing.T) {
	s, server := fixtureService(t, nil)
	cfg := Config{BaseURL: "https://gateway.example/v1", Model: "fixture", Protocol: ProtocolOpenAIChat, APIKey: "never-return-this-key"}
	raw, _ := json.Marshal(cfg)
	if err := s.options.Store.Put(context.Background(), "config", raw); err != nil {
		t.Fatal(err)
	}
	status, billing := billingRequest(t, server.URL, http.MethodGet, Billing{})
	if status != 200 || billing.Currency != "CNY" || billing.InputPricePerMillion != nil || billing.OutputPricePerMillion != nil {
		t.Fatalf("initial billing must be unknown: %d %+v", status, billing)
	}
	zero, output := 0.0, 12.5
	billing.InputPricePerMillion, billing.OutputPricePerMillion = &zero, &output
	if status, saved := billingRequest(t, server.URL, http.MethodPut, billing); status != 200 || saved.InputPricePerMillion == nil || *saved.InputPricePerMillion != 0 || *saved.OutputPricePerMillion != output {
		t.Fatalf("free price lost: %d %+v", status, saved)
	}
	// Changing protocol at the same gateway is a separate price identity.
	stale := billing
	cfg.Protocol = ProtocolAnthropic
	raw, _ = json.Marshal(cfg)
	_ = s.options.Store.Put(context.Background(), "config", raw)
	if status, _ := billingRequest(t, server.URL, http.MethodPut, stale); status != http.StatusConflict {
		t.Fatalf("stale pricing saved to another model: %d", status)
	}
	if status, got := billingRequest(t, server.URL, http.MethodGet, Billing{}); status != 200 || got.InputPricePerMillion != nil || got.Protocol != ProtocolAnthropic {
		t.Fatalf("cross-protocol pricing reused: %d %+v", status, got)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		req, _ := http.NewRequest(method, server.URL+"/api/v1/assistant/billing", bytes.NewReader([]byte(`{}`)))
		req.Header.Set("X-Member", "member")
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("member billing %s: %d", method, resp.StatusCode)
		}
	}
}

func TestModelBillingRejectsInvalidPriceAndUnconfiguredModel(t *testing.T) {
	s, server := fixtureService(t, nil)
	identity := billingIdentity(Config{})
	if status, _ := billingRequest(t, server.URL, http.MethodPut, identity); status != 400 {
		t.Fatalf("unconfigured billing: %d", status)
	}
	_ = s.options.Store.Put(context.Background(), "config", []byte(`{"base_url":"https://gateway.example/v1","model":"fixture"}`))
	_, identity = billingRequest(t, server.URL, http.MethodGet, Billing{})
	for _, bad := range []string{
		`{"base_url":"https://gateway.example/v1","protocol":"openai-chat-completions","model":"fixture","currency":"CNY","input_price_per_million":-1}`,
		`{"base_url":"https://gateway.example/v1","protocol":"openai-chat-completions","model":"fixture","currency":"USD","output_price_per_million":1000000001}`,
		`{"base_url":"https://gateway.example/v1","protocol":"openai-chat-completions","model":"fixture","currency":"XXX"}`,
		`{"base_url":"https://gateway.example/v1","protocol":"openai-chat-completions","model":"fixture","currency":"CNY","input_price_per_million":1e1000}`,
	} {
		status, _ := request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/billing", bad)
		if status != 400 {
			t.Fatalf("invalid price accepted: %d %s", status, bad)
		}
	}
	if status, got := billingRequest(t, server.URL, http.MethodGet, Billing{}); status != 200 || got.InputPricePerMillion != nil || got.OutputPricePerMillion != nil {
		t.Fatalf("rejected price mutated billing: %+v", got)
	}
}

func TestUsageCostsSnapshotMissingAndDuplicateEvents(t *testing.T) {
	s, _ := fixtureService(t, nil)
	in, out := 2.0, 8.0
	billing := Billing{BaseURL: "https://gateway.example/v1", Protocol: ProtocolOpenAIChat, Model: "first", Currency: "USD", InputPricePerMillion: &in, OutputPricePerMillion: &out}
	event := Event{SessionID: "session", TurnID: "turn", Sequence: 1, Type: "turn.usage", Timestamp: now(), Data: map[string]any{"input_tokens": 1000000, "output_tokens": 500000, "phase": "compact"}}
	if err := s.recordModelUsage(event, "assistant", "alice", billing); err != nil {
		t.Fatal(err)
	}
	// Replayed consumption is immutable, including its original price snapshot.
	in = 100
	if err := s.recordModelUsage(event, "assistant", "alice", billing); err != nil {
		t.Fatal(err)
	}
	event.Sequence = 2
	event.Data = map[string]any{"input_tokens": 0}
	if err := s.recordModelUsage(event, "assistant", "alice", billing); err != nil {
		t.Fatal(err)
	}
	event.Sequence = 3
	event.Data = map[string]any{"input_tokens": 0, "output_tokens": 0, "source": "injected", "estimated_cost": 123.0, "currency": "USD"}
	billing.InputPricePerMillion, billing.OutputPricePerMillion = nil, nil
	if err := s.recordModelUsage(event, "assistant", "alice", billing); err != nil {
		t.Fatal(err)
	}
	records, err := s.options.Store.(UsageStore).ListUsage(context.Background(), time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
	if err != nil || len(records) != 3 {
		t.Fatalf("ledger: %d %v", len(records), err)
	}
	byID := map[string]UsageRecord{}
	for _, record := range records {
		byID[record.ID] = record
	}
	first := byID["session/turn/1"]
	if first.EstimatedCost == nil || math.Abs(*first.EstimatedCost-6) > 1e-9 || first.Model != "first" || first.Phase != "compact" || first.Currency != "USD" {
		t.Fatalf("original price snapshot lost: %+v", first)
	}
	partial := byID["session/turn/2"]
	if partial.EstimatedCost == nil || *partial.EstimatedCost != 0 || partial.CostStatus != CostPartial || partial.OutputTokens != nil || partial.OutputEstimatedCost != nil || byID["session/turn/3"].EstimatedCost != nil || byID["session/turn/3"].Source != "assistant" {
		t.Fatal("partial cost lost, or unknown usage/prices treated as free")
	}
}

func TestUsagePriceComponentsPreservePartialAndAuditRates(t *testing.T) {
	tests := []struct {
		name                        string
		in, out                     *int64
		inputPrice, outputPrice     *float64
		status                      string
		cost, inputCost, outputCost *float64
	}{
		{"complete", usageInt(1000000), usageInt(500000), usageFloat(2), usageFloat(8), CostComplete, usageFloat(6), usageFloat(2), usageFloat(4)},
		{"output usage unknown", usageInt(1000000), nil, usageFloat(2), usageFloat(8), CostPartial, usageFloat(2), usageFloat(2), nil},
		{"input usage unknown", nil, usageInt(500000), usageFloat(2), usageFloat(8), CostPartial, usageFloat(4), nil, usageFloat(4)},
		{"output price unknown", usageInt(1000000), usageInt(500000), usageFloat(2), nil, CostPartial, usageFloat(2), usageFloat(2), nil},
		{"both rates unknown", usageInt(0), usageInt(0), nil, nil, CostUnpriced, nil, nil, nil},
		{"known zero partial", usageInt(0), nil, usageFloat(2), usageFloat(8), CostPartial, usageFloat(0), usageFloat(0), nil},
		{"explicit free", usageInt(1000000), usageInt(500000), usageFloat(0), usageFloat(0), CostComplete, usageFloat(0), usageFloat(0), usageFloat(0)},
		{"free but usage unknown", nil, nil, usageFloat(0), usageFloat(0), CostUnpriced, nil, nil, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := UsageRecord{InputTokens: test.in, OutputTokens: test.out, EstimatedCost: usageFloat(999)}
			applyUsagePricing(&record, Billing{InputPricePerMillion: test.inputPrice, OutputPricePerMillion: test.outputPrice})
			if record.CostStatus != test.status || !reflect.DeepEqual(record.EstimatedCost, test.cost) || !reflect.DeepEqual(record.InputEstimatedCost, test.inputCost) || !reflect.DeepEqual(record.OutputEstimatedCost, test.outputCost) || !reflect.DeepEqual(record.InputPricePerMillion, test.inputPrice) || !reflect.DeepEqual(record.OutputPricePerMillion, test.outputPrice) {
				t.Fatalf("cost coverage/audit snapshot: %+v", record)
			}
			if test.inputPrice != nil {
				*test.inputPrice = 999
				if *record.InputPricePerMillion == 999 {
					t.Fatal("snapshot aliases mutable rate")
				}
			}
		})
	}
}

func TestTurnAndFailedConnectionPersistReportedUsage(t *testing.T) {
	s, server := fixtureService(t, nil)
	cfg := Config{BaseURL: "https://gateway.example/v1", Protocol: ProtocolOpenAIChat, Model: " fixture ", Enabled: true}
	raw, _ := json.Marshal(cfg)
	status, body := request(t, server.Client(), http.MethodPut, server.URL+"/api/v1/assistant/config", string(raw))
	if status != 200 || !bytes.Contains(body, []byte(`"model":"fixture"`)) {
		t.Fatalf("saved model must be trimmed consistently with connection tests: %d %s", status, body)
	}
	_, billing := billingRequest(t, server.URL, http.MethodGet, Billing{})
	in, out := 1.0, 2.0
	billing.InputPricePerMillion, billing.OutputPricePerMillion = &in, &out
	if status, _ := billingRequest(t, server.URL, http.MethodPut, billing); status != 200 {
		t.Fatal("cannot save rates")
	}
	s.options.Runtime = usageFixtureRuntime(func(_ context.Context, input RuntimeInput, emit func(RuntimeFrame) error) error {
		if input.Config.Model != "fixture" {
			t.Errorf("runtime model not normalized: %q", input.Config.Model)
		}
		// A concurrent price edit applies only to subsequent calls/turns.
		newPrice := 100.0
		changed := billing
		changed.InputPricePerMillion = &newPrice
		b, _ := json.Marshal(changed)
		_ = s.options.Store.Put(context.Background(), billingKey(changed), b)
		for _, phase := range []string{"compact", "execute"} {
			if err := emit(RuntimeFrame{Type: "event", Name: "turn.usage", Data: map[string]any{"input_tokens": 100, "output_tokens": 20, "phase": phase}}); err != nil {
				return err
			}
		}
		return errors.New("provider failed after reporting consumption")
	})
	session := createSession(t, server)
	status, body = request(t, server.Client(), http.MethodPost, server.URL+"/api/v1/assistant/sessions/"+session.ID+"/turns", `{"text":"hello"}`)
	if status != 200 || !bytes.Contains(body, []byte("turn.failed")) {
		t.Fatalf("expected failed turn: %d %s", status, body)
	}
	status, _ = connectionRequest(t, server.URL, map[string]any{"base_url": cfg.BaseURL, "protocol": cfg.Protocol, "model": "fixture"})
	if status != http.StatusBadGateway {
		t.Fatalf("expected failed connection: %d", status)
	}
	records, err := s.options.Store.(UsageStore).ListUsage(context.Background(), time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
	if err != nil || len(records) != 4 {
		t.Fatalf("failed calls lost consumption: %d %v", len(records), err)
	}
	for _, record := range records {
		if record.EstimatedCost == nil {
			t.Fatalf("priced usage missing cost: %+v", record)
		}
		if record.Source == "assistant" && math.Abs(*record.EstimatedCost-0.00014) > 1e-9 {
			t.Fatalf("in-flight turn repriced: %+v", record)
		}
		if record.Source == "connection-test" && math.Abs(*record.EstimatedCost-0.01004) > 1e-9 {
			t.Fatalf("next call did not use new price: %+v", record)
		}
	}
}
