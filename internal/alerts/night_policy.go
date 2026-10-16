package alerts

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func resetNightProgressTx(tx *sql.Tx, episode string) error {
	if episode == "" {
		return nil
	}
	_, e := tx.Exec(`UPDATE alert_responses SET body=json_set(body,'$.night_count',0,'$.night_last_round_at','','$.night_eligible_at','') WHERE episode=? AND state NOT IN ('resolved','cancelled')`, episode)
	return e
}

// Each off-hours window starts at the end of its daytime window. Using its
// local calendar date keeps counts separate across nights, timezones and DST.
func (r IncidentResponse) nightPeriod(now time.Time) string {
	p := r.Group.policy(r.Priority)
	if p.Start == "" || p.End == "" || p.Start == p.End || !windowAllowed(now, r.Group.Timezone, p.End, p.Start, p.Weekdays) {
		return ""
	}
	loc, e := time.LoadLocation(r.Group.Timezone)
	if e != nil {
		return ""
	}
	n := now.In(loc)
	end, e := clockMinutes(p.End)
	if e != nil {
		return ""
	}
	if n.Hour()*60+n.Minute() < end {
		n = n.AddDate(0, 0, -1)
	}
	return r.Priority + ":" + stamp(time.Date(n.Year(), n.Month(), n.Day(), end/60, end%60, 0, 0, loc))
}

func (r IncidentResponse) notificationMethods(now time.Time) []string {
	p := r.Group.policy(r.Priority)
	if r.nightPeriod(now) != "" && (p.NightMode == "immediate" || p.NightMode == "after_count") {
		return p.NightMethods
	}
	return p.Methods
}

// These are platform reminder rounds AFTER the rule has fired, independent of
// the rule's consecutive evaluation count. Never infer missed rounds on restart.
func (m *Module) advanceNightRound(ctx context.Context, r *IncidentResponse, rule Rule, now time.Time, silences []Silence) error {
	p := r.Group.policy(r.Priority)
	period := r.nightPeriod(now)
	if p.NightMode != "after_count" || period == "" || r.State != "unclaimed" {
		return nil
	}
	if reason := allowedResponse(*r, now, silences, rule.SilenceUntil); reason != "" && !strings.HasPrefix(reason, "夜间仅记录") {
		return nil
	}
	if r.NightPeriod != period {
		r.NightPeriod, r.NightCount, r.NightLastRoundAt, r.NightEligibleAt = period, 0, "", ""
	}
	var raw string
	if e := m.deps.DB.QueryRowContext(ctx, "SELECT body FROM alert_states WHERE rule_id=? AND fingerprint=?", r.RuleID, r.Event.State.Fingerprint).Scan(&raw); e != nil {
		return e
	}
	var state State
	if e := json.Unmarshal([]byte(raw), &state); e != nil {
		return e
	}
	active := state.Episode == r.Episode && state.Status == "firing" && state.Health == "ok"
	if r.Event.Kind == "error" || r.Event.Kind == "no_data" {
		active = state.HealthEpisode == r.Episode && state.Health == r.Event.Kind
	}
	if !active || now.Sub(parse(state.LastEval)) > time.Duration(2*rule.IntervalSeconds)*time.Second {
		r.NightCount, r.NightLastRoundAt, r.NightEligibleAt = 0, "", ""
		return nil
	}
	if r.NightEligibleAt != "" || r.NightLastRoundAt != "" && (now.Sub(parse(r.NightLastRoundAt)) < time.Duration(p.RepeatSeconds)*time.Second || !parse(state.LastEval).After(parse(r.NightLastRoundAt))) {
		return nil
	}
	r.NightCount++
	r.NightLastRoundAt = stamp(now)
	message := fmt.Sprintf("夜间仅记录：同一指标持续告警第%d/%d轮，间隔%d秒", r.NightCount, p.NightAfterCount, p.RepeatSeconds)
	reached := r.NightCount >= p.NightAfterCount
	if reached {
		r.NightEligibleAt = stamp(now)
		// Start a fresh paging cycle with the primary when the gate opens.
		r.LastTick, r.Stage = stamp(now), "primary"
		r.Round, r.StageRound, r.SuccessfulRounds, r.CountedRound = 0, 0, 0, 0
		r.LevelActiveSeconds, r.SinceRoundSeconds = 0, 0
		r.Exhausted = false
		r.Generation++
		message = fmt.Sprintf("夜间持续告警达到%d轮，开始按夜间方式通知", p.NightAfterCount)
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if reached {
		if _, e = tx.Exec("UPDATE alert_outbox SET status='cancelled' WHERE status IN ('queued','retry') AND json_extract(body,'$.response_id')=?", r.ID); e != nil {
			return e
		}
	}
	if e = saveResponse(tx, *r); e != nil {
		return e
	}
	if e = auditResponse(tx, *r, "night_recorded", "", "", message, now); e != nil {
		return e
	}
	return tx.Commit()
}
