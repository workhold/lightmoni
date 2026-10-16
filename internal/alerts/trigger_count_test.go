package alerts

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestConsecutiveDetectionsFilterSpikesAndReset(t *testing.T) {
	rule := Rule{ID: "rule", IntervalSeconds: 10, ForCount: 3}
	now := parse("2026-10-16T14:00:00Z")
	input := State{Fingerprint: "instance-a", Labels: map[string]string{"instance": "a"}, Health: "ok", Status: "firing"}
	var state State
	step := func(in State, seconds int) []string {
		t.Helper()
		now = now.Add(time.Duration(seconds) * time.Second)
		var events []string
		state, events = transition(state, in, rule, now)
		return events
	}
	step(input, 0)
	step(input, 0) // Duplicate evaluation is not another observation.
	if state.ConsecutiveFailures != 1 || state.Status != "pending" {
		t.Fatalf("duplicate evaluation counted: %+v", state)
	}
	normal := input
	normal.Status = "normal"
	if events := step(normal, 10); len(events) != 0 || state.ConsecutiveFailures != 0 {
		t.Fatalf("single spike produced an alarm: %+v, %v", state, events)
	}
	step(input, 10)
	step(input, 10)
	failed := input
	failed.Health = "error"
	step(failed, 10)
	step(input, 10)
	if state.ConsecutiveFailures != 1 || state.Episode != "" {
		t.Fatalf("query failure did not break consecutive detections: %+v", state)
	}
	step(input, 30)
	if state.ConsecutiveFailures != 1 {
		t.Fatalf("detection gap did not reset: %+v", state)
	}
	step(input, 10)
	if events := step(input, 10); len(events) != 1 || events[0] != "firing" || state.ConsecutiveFailures != 3 {
		t.Fatalf("third consecutive detection did not fire: %+v, %v", state, events)
	}
	if events := step(normal, 10); len(events) != 1 || events[0] != "resolved" || state.ConsecutiveFailures != 0 {
		t.Fatalf("recovery did not reset: %+v, %v", state, events)
	}
}

func TestConsecutiveDetectionsAndDurationBothRequired(t *testing.T) {
	for _, tc := range []struct{ count, duration, fireAt int }{{3, 0, 20}, {1, 30, 30}, {3, 60, 60}, {5, 20, 40}, {0, 0, 0}} {
		t.Run(encode(tc), func(t *testing.T) {
			rule := Rule{ID: "rule", IntervalSeconds: 10, ForCount: tc.count, ForSeconds: tc.duration}
			var state State
			for seconds := 0; seconds <= tc.fireAt; seconds += 10 {
				var events []string
				state, events = transition(state, State{Health: "ok", Status: "firing"}, rule, parse("2026-10-16T14:00:00Z").Add(time.Duration(seconds)*time.Second))
				if (len(events) > 0) != (seconds == tc.fireAt) {
					t.Fatalf("fired at %d, expected %d: %+v", seconds, tc.fireAt, state)
				}
			}
		})
	}
}

func TestTriggerCountAPIPersistsAndValidates(t *testing.T) {
	m, mux := testModule(t)
	rule := seed(t, m, mux, "http://localhost/unused")
	if rule.ForCount != 1 {
		t.Fatalf("legacy default = %d", rule.ForCount)
	}
	rule.ForCount = 3
	if e := json.Unmarshal(request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 200), &rule); e != nil {
		t.Fatal(e)
	}
	rules, e := m.rules(context.Background())
	if e != nil || len(rules) != 1 || rules[0].ForCount != 3 {
		t.Fatalf("saved count missing: %+v, %v", rules, e)
	}
	for _, count := range []int{-1, 1001} {
		rule.ForCount = count
		request(t, mux, "PUT", "/api/v1/alerts/rules/"+rule.ID, rule, 400)
	}
}
