package moni

import (
	"errors"
	"time"
)

type MetricWindow struct {
	Seconds     int64 `json:"seconds"`
	EffectiveAt int64 `json:"effective_at"`
}

func validMetricWindows(policies map[string][]MetricWindow) error {
	if len(policies) > 200 {
		return errors.New("too many metric window policies")
	}
	for table, history := range policies {
		if !validTable(table) || len(history) > 256 {
			return errors.New("invalid metric window history")
		}
		previous := int64(-1)
		for _, p := range history {
			valid := false
			for _, v := range []int64{10, 30, 60, 300, 600, 1800, 3600} {
				valid = valid || p.Seconds == v
			}
			if !valid || p.EffectiveAt < 0 || p.EffectiveAt <= previous || p.EffectiveAt%p.Seconds != 0 {
				return errors.New("invalid metric window policy")
			}
			previous = p.EffectiveAt
		}
	}
	return nil
}
func metricWindowAt(policies map[string][]MetricWindow, table string, at time.Time) (time.Time, int64) {
	seconds := int64(30)
	for _, p := range policies[table] {
		if p.EffectiveAt <= at.Unix() {
			seconds = p.Seconds
		}
	}
	return time.Unix(at.Unix()/seconds*seconds, 0), seconds
}
