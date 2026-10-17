package assistant

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

// Billing is keyed by the actual connection, including protocol and model.
// Nullable prices distinguish an unknown rate from an explicitly free model.
type Billing struct {
	BaseURL               string   `json:"base_url"`
	Protocol              string   `json:"protocol"`
	Model                 string   `json:"model"`
	Currency              string   `json:"currency"`
	InputPricePerMillion  *float64 `json:"input_price_per_million"`
	OutputPricePerMillion *float64 `json:"output_price_per_million"`
}

func billingIdentity(cfg Config) Billing {
	cfg = normalizedConfig(cfg)
	base := cfg.BaseURL
	if canonical, err := canonicalBaseIdentity(base); err == nil {
		base = canonical
	}
	return Billing{BaseURL: base, Protocol: cfg.Protocol, Model: cfg.Model, Currency: "CNY"}
}

func billingKey(b Billing) string {
	identity, _ := json.Marshal([]string{b.BaseURL, b.Protocol, b.Model})
	sum := sha256.Sum256(identity)
	return "billing/" + hex.EncodeToString(sum[:])
}

func sameBillingIdentity(a, b Billing) bool {
	return a.BaseURL == b.BaseURL && a.Protocol == b.Protocol && a.Model == b.Model
}

func validPrice(price *float64) bool {
	return price == nil || (!math.IsNaN(*price) && !math.IsInf(*price, 0) && *price >= 0 && *price <= 1e9)
}

func (s *Service) loadBilling(ctx context.Context, cfg Config) (Billing, error) {
	billing := billingIdentity(cfg)
	b, err := s.options.Store.Get(ctx, billingKey(billing))
	if errors.Is(err, ErrNotFound) {
		return billing, nil
	}
	if err != nil {
		return billing, err
	}
	var saved Billing
	if err := json.Unmarshal(b, &saved); err != nil {
		return billing, err
	}
	if !sameBillingIdentity(billing, saved) || (saved.Currency != "CNY" && saved.Currency != "USD") || !validPrice(saved.InputPricePerMillion) || !validPrice(saved.OutputPricePerMillion) {
		return billing, errors.New("invalid stored model pricing")
	}
	return saved, nil
}

func (s *Service) billing(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	if !p.Admin {
		shared.Error(w, http.StatusForbidden, "administrator required")
		return
	}
	cfg, err := s.loadConfig(r.Context())
	if err != nil {
		shared.Error(w, 500, "cannot read assistant configuration")
		return
	}
	if r.Method == http.MethodPut {
		var incoming Billing
		if err := decode(r, &incoming, 4096); err != nil {
			shared.Error(w, 400, "invalid model pricing")
			return
		}
		if !sameBillingIdentity(incoming, billingIdentity(cfg)) {
			shared.Error(w, http.StatusConflict, "model connection changed; reload pricing before saving")
			return
		}
		if strings.TrimSpace(cfg.Model) == "" || cfg.BaseURL == "" {
			shared.Error(w, 400, "configure a model before setting prices")
			return
		}
		if (incoming.Currency != "CNY" && incoming.Currency != "USD") || !validPrice(incoming.InputPricePerMillion) || !validPrice(incoming.OutputPricePerMillion) {
			shared.Error(w, 400, "prices must be between 0 and 1000000000; currency must be CNY or USD")
			return
		}
		b, _ := json.Marshal(incoming)
		if err := s.options.Store.Put(r.Context(), billingKey(incoming), b); err != nil {
			shared.Error(w, 500, "cannot save model pricing")
			return
		}
		shared.JSON(w, http.StatusOK, incoming)
		return
	}
	billing, err := s.loadBilling(r.Context(), cfg)
	if err != nil {
		shared.Error(w, 500, "cannot read model pricing")
		return
	}
	shared.JSON(w, http.StatusOK, billing)
}

// recordModelUsage uses the immutable connection/rate snapshot captured before
// the provider call. A later price edit never changes a recorded estimate.
func (s *Service) recordModelUsage(event Event, source, userID string, billing Billing) error {
	record, ok := usageRecordFromEvent(event, source)
	if !ok {
		return nil
	}
	store, ok := s.options.Store.(UsageStore)
	if !ok {
		return errors.New("assistant usage accounting is unavailable")
	}
	record.UserID = userID
	record.Source = source
	record.BaseURL, record.Protocol, record.Model = billing.BaseURL, billing.Protocol, billing.Model
	record.Currency = billing.Currency
	applyUsagePricing(&record, billing)
	// A cancelled HTTP request must not erase consumption already reported by
	// the provider. Bound the independent write instead of using its context.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return store.RecordUsage(ctx, record)
}

func usageComponentCost(tokens *int64, price *float64) *float64 {
	if tokens == nil || *tokens < 0 || price == nil || !validPrice(price) {
		return nil
	}
	cost := float64(*tokens) * *price / 1e6
	if math.IsNaN(cost) || math.IsInf(cost, 0) {
		return nil
	}
	return &cost
}

func cloneUsagePrice(value *float64) *float64 {
	if value == nil {
		return nil
	}
	n := *value
	return &n
}

// Keep rates and each known component with the result. A partial estimate is
// explicitly a known subtotal, never an assertion that missing usage was free.
func applyUsagePricing(record *UsageRecord, billing Billing) {
	record.InputPricePerMillion = cloneUsagePrice(billing.InputPricePerMillion)
	record.OutputPricePerMillion = cloneUsagePrice(billing.OutputPricePerMillion)
	record.InputEstimatedCost = usageComponentCost(record.InputTokens, record.InputPricePerMillion)
	record.OutputEstimatedCost = usageComponentCost(record.OutputTokens, record.OutputPricePerMillion)
	record.EstimatedCost = nil
	record.CostStatus = CostUnpriced
	if record.InputEstimatedCost == nil && record.OutputEstimatedCost == nil {
		return
	}
	known := 0.0
	if record.InputEstimatedCost != nil {
		known += *record.InputEstimatedCost
	}
	if record.OutputEstimatedCost != nil {
		known += *record.OutputEstimatedCost
	}
	record.EstimatedCost = &known
	record.CostStatus = CostPartial
	if record.InputEstimatedCost != nil && record.OutputEstimatedCost != nil {
		record.CostStatus = CostComplete
	}
}
