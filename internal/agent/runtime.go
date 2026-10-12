package agent

import (
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Runtime diagnostics have their own bounded buffer. Queue failures must never
// recursively enqueue another failing OTLP batch.
type RuntimeEvent struct {
	ID   string    `json:"id"`
	Time time.Time `json:"time"
 "unicode/utf8"`
	Severity string `json:"severity"`
	Event    string `json:"event"`
	Body     string `json:"body"`
}

func (a *Agent) safeRuntimeMessage(message string) string {
	for _, secret := range []string{a.cfg.Key, a.cfg.LocalToken} {
		if secret != "" {
			message = strings.ReplaceAll(message, secret, "[redacted]")
		}
	}
	// Bound each diagnostic message and preserve valid UTF-8.
	if len(message) > 1024 {
		message = message[:1024]
		for !utf8.ValidString(message) {
			message = message[:len(message)-1]
		}
	}
	return message
}
func (a *Agent) runtimeEvent(level, event, body string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.runtimeSequence++
	if len(a.runtimeEvents) >= 64 {
		a.runtimeEvents = append([]RuntimeEvent(nil), a.runtimeEvents[1:]...)
	}
	a.runtimeEvents = append(a.runtimeEvents, RuntimeEvent{ID: a.runtimeInstance + "-" + strconv.FormatUint(a.runtimeSequence, 10), Time: time.Now().UTC(), Severity: level, Event: event, Body: body})
}
func (a *Agent) acknowledgeRuntime(status map[string]any) {
	sent, _ := status["runtime_events"].([]RuntimeEvent)
	ids := map[string]bool{}
	for _, event := range sent {
		ids[event.ID] = true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	kept := a.runtimeEvents[:0]
	for _, event := range a.runtimeEvents {
		if !ids[event.ID] {
			kept = append(kept, event)
		}
	}
	a.runtimeEvents = kept
}
