package assistant

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"time"
)

var usageRequestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// A recorder belongs to one runtime invocation. Workers report stable request
// IDs; the host supplies all accounting identity, rates and completion fallback.
type usageRecorder struct {
	service                           *Service
	source, userID, sessionID, turnID string
	billing                           Billing
	pending                           map[string]UsageRecord
	terminal                          map[string]bool
}

func newUsageRecorder(s *Service, source, userID, sessionID, turnID string, billing Billing) *usageRecorder {
	billing.InputPricePerMillion = cloneUsagePrice(billing.InputPricePerMillion)
	billing.OutputPricePerMillion = cloneUsagePrice(billing.OutputPricePerMillion)
	return &usageRecorder{service: s, source: source, userID: userID, sessionID: sessionID, turnID: turnID, billing: billing, pending: map[string]UsageRecord{}, terminal: map[string]bool{}}
}

func (recorder *usageRecorder) record(event Event) error {
	if event.Type != "model.request.started" && event.Type != "turn.usage" {
		return nil
	}
	requestID, _ := event.Data["request_id"].(string)
	if requestID == "" && event.Type == "turn.usage" {
		// Old workers and retained history have no lifecycle ID. Keep their
		// original event identity and do not invent a successful status.
		return recorder.service.recordModelUsage(event, recorder.source, recorder.userID, recorder.billing)
	}
	if !usageRequestID.MatchString(requestID) {
		return errors.New("invalid model request ID")
	}
	if recorder.terminal[requestID] {
		return nil
	}
	if _, exists := recorder.pending[requestID]; exists && event.Type == "model.request.started" {
		return nil
	}
	status := UsagePending
	if event.Type == "turn.usage" {
		status, _ = event.Data["status"].(string)
		if !terminalUsageStatus(status) {
			return errors.New("invalid model request status")
		}
	}
	// Session/turn/source identity comes from the host, never event metadata.
	event.SessionID, event.TurnID = recorder.sessionID, recorder.turnID
	if event.Timestamp == "" {
		event.Timestamp = now()
	}
	event.Type = "turn.usage"
	record, _ := usageRecordFromEvent(event, recorder.source)
	record.UserID, record.Source, record.Status = recorder.userID, recorder.source, status
	if terminalUsageStatus(status) {
		record.CompletedAt = event.Timestamp
	}
	record.BaseURL, record.Protocol, record.Model = recorder.billing.BaseURL, recorder.billing.Protocol, recorder.billing.Model
	record.Currency = recorder.billing.Currency
	if status == UsagePending {
		record.InputTokens, record.OutputTokens, record.TotalTokens = nil, nil, nil
	}
	applyUsagePricing(&record, recorder.billing)
	if previous, ok := recorder.pending[requestID]; ok && terminalUsageStatus(status) {
		record, _ = mergeUsageRecord(previous, record)
	}
	if err := recorder.persist(record); err != nil {
		return err
	}
	if status == UsagePending {
		recorder.pending[requestID] = record
	} else {
		delete(recorder.pending, requestID)
		recorder.terminal[requestID] = true
	}
	return nil
}

func (recorder *usageRecorder) persist(record UsageRecord) error {
	store, ok := recorder.service.options.Store.(UsageStore)
	if !ok {
		return errors.New("assistant usage accounting is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return store.RecordUsage(ctx, record)
}

// A killed worker cannot emit its final frame. The host finishes only requests
// whose start it observed; missing consumption stays unknown and is not zeroed.
func (recorder *usageRecorder) finish(status string) error {
	if status != UsageFailed && status != UsageCancelled {
		return errors.New("invalid model request fallback status")
	}
	ids := make([]string, 0, len(recorder.pending))
	for id := range recorder.pending {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		record := recorder.pending[id]
		record.Status, record.CompletedAt = status, now()
		if err := recorder.persist(record); err != nil {
			return err
		}
		delete(recorder.pending, id)
		recorder.terminal[id] = true
	}
	return nil
}
