package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

// UsageRecord is an immutable snapshot of one provider request. Missing counts
// and prices remain nil so that unreported usage is never presented as free.
type UsageRecord struct {
	ID                    string   `json:"id"`
	RequestID             string   `json:"request_id,omitempty"`
	Status                string   `json:"status,omitempty"`
	Timestamp             string   `json:"timestamp"`
	CompletedAt           string   `json:"completed_at,omitempty"`
	FailureReason         string   `json:"failure_reason,omitempty"`
	UserID                string   `json:"user_id"`
	SessionID             string   `json:"session_id"`
	TurnID                string   `json:"turn_id"`
	Source                string   `json:"source"`
	Phase                 string   `json:"phase"`
	BaseURL               string   `json:"base_url"`
	Protocol              string   `json:"protocol"`
	Model                 string   `json:"model"`
	InputTokens           *int64   `json:"input_tokens"`
	OutputTokens          *int64   `json:"output_tokens"`
	TotalTokens           *int64   `json:"total_tokens"`
	Currency              string   `json:"currency"`
	EstimatedCost         *float64 `json:"estimated_cost"`
	InputPricePerMillion  *float64 `json:"input_price_per_million"`
	OutputPricePerMillion *float64 `json:"output_price_per_million"`
	InputEstimatedCost    *float64 `json:"input_estimated_cost"`
	OutputEstimatedCost   *float64 `json:"output_estimated_cost"`
	CostStatus            string   `json:"cost_status,omitempty"`
}

// UsageStore is separate from the bounded session document API. Entries survive
// session-event trimming and are shared across all users of the installation.
type UsageStore interface {
	RecordUsage(context.Context, UsageRecord) error
	ListUsage(context.Context, string, string) ([]UsageRecord, error)
}

const (
	UsagePending   = "pending"
	UsageSucceeded = "succeeded"
	UsageFailed    = "failed"
	UsageCancelled = "cancelled"
	CostComplete   = "complete"
	CostPartial    = "partial"
	CostUnpriced   = "unpriced"
	CostLegacy     = "legacy"
)

func terminalUsageStatus(status string) bool {
	return status == UsageSucceeded || status == UsageFailed || status == UsageCancelled
}

func requestUsageID(sessionID, turnID, requestID string) string {
	return fmt.Sprintf("%s/%s/request/%s", sessionID, turnID, requestID)
}

func usageCount(value any) *int64 {
	var n int64
	switch v := value.(type) {
	case int:
		n = int64(v)
	case int8:
		n = int64(v)
	case int16:
		n = int64(v)
	case int32:
		n = int64(v)
	case int64:
		n = v
	case uint:
		if uint64(v) > math.MaxInt64 {
			return nil
		}
		n = int64(v)
	case uint8:
		n = int64(v)
	case uint16:
		n = int64(v)
	case uint32:
		n = int64(v)
	case uint64:
		if v > math.MaxInt64 {
			return nil
		}
		n = int64(v)
	case float32:
		return usageCount(float64(v))
	case float64:
		// float64(math.MaxInt64) rounds up to 2^63, which cannot fit int64.
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v >= 9223372036854775808 || math.Trunc(v) != v {
			return nil
		}
		n = int64(v)
	case json.Number:
		// Bound arbitrary-precision work on untrusted historical JSON. Every
		// nonnegative int64 has a much shorter ordinary decimal representation.
		if len(v) > 128 || !json.Valid([]byte(v)) {
			return nil
		}
		if index := strings.IndexAny(string(v), "eE"); index >= 0 {
			exponent, err := strconv.Atoi(string(v[index+1:]))
			if err != nil || exponent < -128 || exponent > 128 {
				return nil
			}
		}
		r, ok := new(big.Rat).SetString(string(v))
		if !ok || !r.IsInt() || !r.Num().IsInt64() {
			return nil
		}
		n = r.Num().Int64()
	default:
		return nil
	}
	if n < 0 {
		return nil
	}
	return &n
}

func usageRecordFromEvent(event Event, source string) (UsageRecord, bool) {
	if event.Type != "turn.usage" {
		return UsageRecord{}, false
	}
	text := func(key string) string {
		value, _ := event.Data[key].(string)
		return value
	}
	record := UsageRecord{
		ID:        fmt.Sprintf("%s/%s/%d", event.SessionID, event.TurnID, event.Sequence),
		Timestamp: event.Timestamp, SessionID: event.SessionID, TurnID: event.TurnID,
		UserID: text("user_id"), Source: source, Phase: text("phase"),
		BaseURL: text("base_url"), Protocol: text("protocol"), Model: text("model"),
		InputTokens: usageCount(event.Data["input_tokens"]), OutputTokens: usageCount(event.Data["output_tokens"]),
		TotalTokens: usageCount(event.Data["total_tokens"]), Currency: text("currency"),
	}
	if requestID := text("request_id"); requestID != "" {
		record.RequestID = requestID
		record.ID = requestUsageID(event.SessionID, event.TurnID, requestID)
	}
	if status := text("status"); record.RequestID != "" && (terminalUsageStatus(status) || status == UsagePending) {
		record.Status = status
	}
	if eventSource := text("source"); eventSource != "" {
		record.Source = eventSource
	}
	if record.TotalTokens == nil && record.InputTokens != nil && record.OutputTokens != nil && *record.InputTokens <= math.MaxInt64-*record.OutputTokens {
		total := *record.InputTokens + *record.OutputTokens
		record.TotalTokens = &total
	}
	switch value := event.Data["estimated_cost"].(type) {
	case float64:
		if value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			record.EstimatedCost = &value
		}
	case json.Number:
		if cost, err := value.Float64(); err == nil && cost >= 0 && !math.IsNaN(cost) && !math.IsInf(cost, 0) {
			record.EstimatedCost = &cost
		}
	}
	if record.EstimatedCost != nil {
		record.CostStatus = CostLegacy
	}
	return record, true
}

type UsageCost struct {
	Currency        string  `json:"currency"`
	Amount          float64 `json:"amount"`
	Requests        int64   `json:"requests"`
	PartialRequests int64   `json:"partial_requests"`
}

type UsageStats struct {
	Requests              int64       `json:"requests"`
	SucceededRequests     int64       `json:"succeeded_requests"`
	FailedRequests        int64       `json:"failed_requests"`
	CancelledRequests     int64       `json:"cancelled_requests"`
	PendingRequests       int64       `json:"pending_requests"`
	UnknownStatusRequests int64       `json:"unknown_status_requests"`
	InputTokens           int64       `json:"input_tokens"`
	OutputTokens          int64       `json:"output_tokens"`
	TotalTokens           int64       `json:"total_tokens"`
	InputMissing          int64       `json:"input_missing"`
	OutputMissing         int64       `json:"output_missing"`
	TotalMissing          int64       `json:"total_missing"`
	UnpricedRequests      int64       `json:"unpriced_requests"`
	PartialPricedRequests int64       `json:"partial_priced_requests"`
	EstimatedCosts        []UsageCost `json:"estimated_costs"`
}

type UsageDaily struct {
	Date string `json:"date"`
	UsageStats
}

type UsageModel struct {
	BaseURL  string `json:"base_url"`
	Protocol string `json:"protocol"`
	Model    string `json:"model"`
	UsageStats
}

type UsageSource struct {
	Source string `json:"source"`
	UsageStats
}

type UsageReport struct {
	Days     int           `json:"days"`
	From     string        `json:"from"`
	To       string        `json:"to"`
	Timezone string        `json:"timezone"`
	Totals   UsageStats    `json:"totals"`
	Daily    []UsageDaily  `json:"daily"`
	Models   []UsageModel  `json:"models"`
	Sources  []UsageSource `json:"sources"`
}

func emptyUsageStats() UsageStats { return UsageStats{EstimatedCosts: []UsageCost{}} }

func addUsageCount(total *int64, value *int64, missing *int64) {
	if value == nil || *value < 0 {
		*missing += 1
		return
	}
	// Retain a valid JSON integer even for a corrupted or implausibly large
	// historical value; overflowing into a negative total would mislead users.
	if *value > math.MaxInt64-*total {
		*total = math.MaxInt64
	} else {
		*total += *value
	}
}

func (stats *UsageStats) add(record UsageRecord) {
	stats.Requests++
	switch record.Status {
	case UsageSucceeded:
		stats.SucceededRequests++
	case UsageFailed:
		stats.FailedRequests++
	case UsageCancelled:
		stats.CancelledRequests++
	case UsagePending:
		stats.PendingRequests++
	default:
		stats.UnknownStatusRequests++
	}
	addUsageCount(&stats.InputTokens, record.InputTokens, &stats.InputMissing)
	addUsageCount(&stats.OutputTokens, record.OutputTokens, &stats.OutputMissing)
	addUsageCount(&stats.TotalTokens, record.TotalTokens, &stats.TotalMissing)
	currency := strings.ToUpper(strings.TrimSpace(record.Currency))
	if record.EstimatedCost == nil || *record.EstimatedCost < 0 || math.IsNaN(*record.EstimatedCost) || math.IsInf(*record.EstimatedCost, 0) || currency == "" {
		stats.UnpricedRequests++
		return
	}
	partial := record.CostStatus == CostPartial
	if partial {
		stats.PartialPricedRequests++
	}
	for i := range stats.EstimatedCosts {
		if stats.EstimatedCosts[i].Currency == currency {
			amount := stats.EstimatedCosts[i].Amount + *record.EstimatedCost
			if !math.IsInf(amount, 0) {
				stats.EstimatedCosts[i].Amount = amount
				if partial {
					stats.EstimatedCosts[i].PartialRequests++
				} else {
					stats.EstimatedCosts[i].Requests++
				}
			} else {
				stats.UnpricedRequests++
			}
			return
		}
	}
	cost := UsageCost{Currency: currency, Amount: *record.EstimatedCost}
	if partial {
		cost.PartialRequests = 1
	} else {
		cost.Requests = 1
	}
	stats.EstimatedCosts = append(stats.EstimatedCosts, cost)
	sort.Slice(stats.EstimatedCosts, func(i, j int) bool { return stats.EstimatedCosts[i].Currency < stats.EstimatedCosts[j].Currency })
}

func usageWindow(at time.Time, days int, location *time.Location) (time.Time, time.Time) {
	local := at.In(location)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, location)
	return today.AddDate(0, 0, -(days - 1)), today.AddDate(0, 0, 1)
}

func buildUsageReport(records []UsageRecord, at time.Time, days int, location *time.Location) UsageReport {
	from, to := usageWindow(at, days, location)
	report := UsageReport{
		Days: days, From: from.UTC().Format(time.RFC3339Nano), To: to.UTC().Format(time.RFC3339Nano), Timezone: location.String(),
		Totals: emptyUsageStats(), Daily: []UsageDaily{}, Models: []UsageModel{}, Sources: []UsageSource{},
	}
	dates := map[string]int{}
	for date := from; date.Before(to); date = date.AddDate(0, 0, 1) {
		label := date.Format("2006-01-02")
		dates[label] = len(report.Daily)
		report.Daily = append(report.Daily, UsageDaily{Date: label, UsageStats: emptyUsageStats()})
	}
	models := map[[3]string]int{}
	sources := map[string]int{}
	for _, record := range records {
		timestamp, err := time.Parse(time.RFC3339Nano, record.Timestamp)
		if err != nil || timestamp.Before(from) || !timestamp.Before(to) {
			continue
		}
		report.Totals.add(record)
		report.Daily[dates[timestamp.In(location).Format("2006-01-02")]].add(record)
		identity := [3]string{record.BaseURL, record.Protocol, record.Model}
		index, ok := models[identity]
		if !ok {
			index = len(report.Models)
			models[identity] = index
			report.Models = append(report.Models, UsageModel{BaseURL: record.BaseURL, Protocol: record.Protocol, Model: record.Model, UsageStats: emptyUsageStats()})
		}
		report.Models[index].add(record)
		index, ok = sources[record.Source]
		if !ok {
			index = len(report.Sources)
			sources[record.Source] = index
			report.Sources = append(report.Sources, UsageSource{Source: record.Source, UsageStats: emptyUsageStats()})
		}
		report.Sources[index].add(record)
	}
	sort.Slice(report.Models, func(i, j int) bool {
		a, b := report.Models[i], report.Models[j]
		if a.BaseURL != b.BaseURL {
			return a.BaseURL < b.BaseURL
		}
		if a.Protocol != b.Protocol {
			return a.Protocol < b.Protocol
		}
		return a.Model < b.Model
	})
	sort.Slice(report.Sources, func(i, j int) bool { return report.Sources[i].Source < report.Sources[j].Source })
	return report
}

func (s *Service) usage(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.actor(w, r)
	if !ok {
		return
	}
	if !actor.Admin {
		shared.Error(w, http.StatusForbidden, "administrator required")
		return
	}
	days := 30
	if value := r.URL.Query().Get("days"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || (parsed != 7 && parsed != 30 && parsed != 90) {
			shared.Error(w, http.StatusBadRequest, "days must be 7, 30 or 90")
			return
		}
		days = parsed
	}
	location := time.UTC
	if value := r.URL.Query().Get("timezone"); value != "" {
		parsed, err := time.LoadLocation(value)
		if err != nil || value == "Local" {
			shared.Error(w, http.StatusBadRequest, "timezone must be an IANA timezone")
			return
		}
		location = parsed
	}
	store, ok := s.options.Store.(UsageStore)
	if !ok {
		shared.Error(w, http.StatusServiceUnavailable, "assistant usage storage unavailable")
		return
	}
	at := time.Now()
	from, to := usageWindow(at, days, location)
	records, err := store.ListUsage(r.Context(), from.UTC().Format(time.RFC3339Nano), to.UTC().Format(time.RFC3339Nano))
	if err != nil {
		shared.Error(w, http.StatusInternalServerError, "cannot read assistant usage")
		return
	}
	shared.JSON(w, http.StatusOK, buildUsageReport(records, at, days, location))
}

// Details are deliberately bounded and contain only accounting metadata. There
// is no provider credential, prompt, response text or opaque continuation state.
func (s *Service) usageDetails(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.actor(w, r)
	if !ok {
		return
	}
	if !actor.Admin {
		shared.Error(w, http.StatusForbidden, "administrator required")
		return
	}
	days, limit, location := 30, 100, time.UTC
	if value := r.URL.Query().Get("days"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || (parsed != 7 && parsed != 30 && parsed != 90) {
			shared.Error(w, 400, "days must be 7, 30 or 90")
			return
		}
		days = parsed
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			shared.Error(w, 400, "limit must be between 1 and 100")
			return
		}
		limit = parsed
	}
	if value := r.URL.Query().Get("timezone"); value != "" {
		parsed, err := time.LoadLocation(value)
		if err != nil || value == "Local" {
			shared.Error(w, 400, "timezone must be an IANA timezone")
			return
		}
		location = parsed
	}
	store, ok := s.options.Store.(interface {
		ListUsageDetails(context.Context, string, string, int) ([]UsageRecord, error)
	})
	if !ok {
		shared.Error(w, 503, "assistant usage details unavailable")
		return
	}
	from, to := usageWindow(time.Now(), days, location)
	fromText, toText := from.UTC().Format(time.RFC3339Nano), to.UTC().Format(time.RFC3339Nano)
	records, err := store.ListUsageDetails(r.Context(), fromText, toText, limit+1)
	if err != nil {
		shared.Error(w, 500, "cannot read assistant usage details")
		return
	}
	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}
	for i := range records {
		if records[i].CostStatus == "" {
			if records[i].EstimatedCost != nil {
				records[i].CostStatus = CostLegacy
			} else {
				records[i].CostStatus = CostUnpriced
			}
		}
	}
	shared.JSON(w, 200, struct {
		Records  []UsageRecord `json:"records"`
		Limit    int           `json:"limit"`
		HasMore  bool          `json:"has_more"`
		From     string        `json:"from"`
		To       string        `json:"to"`
		Timezone string        `json:"timezone"`
	}{Records: records, Limit: limit, HasMore: hasMore, From: fromText, To: toText, Timezone: location.String()})
}
