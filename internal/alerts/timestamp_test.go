package alerts

import (
	"testing"
	"time"
)

func TestQueueTimestampLexicalOrder(t *testing.T) {
	base := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	times := []time.Time{base, base.Add(100 * time.Millisecond), base.Add(110 * time.Millisecond), base.Add(111 * time.Millisecond), base.Add(time.Second)}
	for i := 1; i < len(times); i++ {
		if stamp(times[i-1]) >= stamp(times[i]) {
			t.Fatalf("SQLite due-time order inverted: %s %s", stamp(times[i-1]), stamp(times[i]))
		}
		if !parse(stamp(times[i])).Equal(times[i]) {
			t.Fatal("timestamp changed")
		}
	}
}
