package alerts

import (
	"fmt"
	"sort"
	"time"
)

type OnCallShift struct {
	Primary []string `json:"primary"`
	Backup  []string `json:"backup"`
}
type OnCallOverride struct {
	ID      string   `json:"id"`
	From    string   `json:"from"`
	Until   string   `json:"until"`
	Primary []string `json:"primary"`
	Backup  []string `json:"backup"`
}
type OnCallSchedule struct {
	Mode         string           `json:"mode"`
	Timezone     string           `json:"timezone"`
	Anchor       string           `json:"anchor"`
	IntervalDays int              `json:"interval_days"`
	Shifts       []OnCallShift    `json:"shifts"`
	Overrides    []OnCallOverride `json:"overrides"`
}
type PriorityPolicy struct {
	Methods              []string `json:"methods"`
	Start                string   `json:"start"`
	End                  string   `json:"end"`
	Weekdays             []int    `json:"weekdays"`
	NightMode            string   `json:"night_mode,omitempty"`
	NightMethods         []string `json:"night_methods,omitempty"`
	NightAfterCount      int      `json:"night_after_count,omitempty"`
	RepeatSeconds        int      `json:"repeat_seconds"`
	BackupAfterSeconds   int      `json:"backup_after_seconds"`
	FallbackAfterSeconds int      `json:"fallback_after_seconds"`
	EscalateAfterRounds  int      `json:"escalate_after_rounds"`
	EscalateTo           string   `json:"escalate_to"`
	MaxRounds            int      `json:"max_rounds"`
	HandlingSeconds      int      `json:"handling_seconds"`
}
type Silence struct {
	ID         string            `json:"id"`
	Scope      string            `json:"scope"`
	GroupID    string            `json:"group_id,omitempty"`
	RuleID     string            `json:"rule_id,omitempty"`
	ResponseID string            `json:"response_id,omitempty"`
	Service    string            `json:"service,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	Priorities []string          `json:"priorities,omitempty"`
	From       string            `json:"from"`
	Until      string            `json:"until"`
	DailyStart string            `json:"daily_start,omitempty"`
	DailyEnd   string            `json:"daily_end,omitempty"`
	Weekdays   []int             `json:"weekdays,omitempty"`
	Timezone   string            `json:"timezone"`
	Reason     string            `json:"reason"`
	CreatedBy  string            `json:"created_by"`
}
type EvidenceProfile struct {
	LogTableID      string            `json:"log_table_id"`
	TraceTableIDs   []string          `json:"trace_table_ids"`
	LabelMappings   map[string]string `json:"label_mappings"`
	LookbackSeconds int               `json:"lookback_seconds"`
}
type Evidence struct {
	Status        string           `json:"status"`
	CapturedAt    string           `json:"captured_at"`
	RangeFrom     string           `json:"from"`
	RangeTo       string           `json:"to"`
	LogTableID    string           `json:"log_table_id"`
	Logs          []map[string]any `json:"logs"`
	TraceIDs      []string         `json:"trace_ids"`
	TraceTableIDs []string         `json:"trace_table_ids"`
	Truncated     bool             `json:"truncated"`
	Error         string           `json:"error,omitempty"`
}
type IncidentResponse struct {
	ID                 string   `json:"id"`
	Episode            string   `json:"episode"`
	RuleID             string   `json:"rule_id"`
	GroupID            string   `json:"group_id"`
	GroupName          string   `json:"group_name"`
	State              string   `json:"state"`
	Priority           string   `json:"priority"`
	OriginalPriority   string   `json:"original_priority"`
	Stage              string   `json:"stage"`
	OwnerID            string   `json:"owner_id"`
	OwnerName          string   `json:"owner_name"`
	AckMethod          string   `json:"ack_method"`
	AckAt              string   `json:"ack_at"`
	HandlingUntil      string   `json:"handling_until"`
	CreatedAt          string   `json:"created_at"`
	ResolvedAt         string   `json:"resolved_at"`
	LastTick           string   `json:"last_tick"`
	LastRoundAt        string   `json:"last_round_at"`
	ActiveSeconds      float64  `json:"active_seconds"`
	LevelActiveSeconds float64  `json:"level_active_seconds"`
	SinceRoundSeconds  float64  `json:"since_round_seconds"`
	Round              int      `json:"round"`
	StageRound         int      `json:"stage_round"`
	SuccessfulRounds   int      `json:"successful_rounds"`
	CountedRound       int      `json:"counted_round"`
	Generation         int      `json:"generation"`
	Exhausted          bool     `json:"exhausted"`
	DeferredReason     string   `json:"deferred_reason"`
	Group              Group    `json:"group"`
	Event              Event    `json:"event"`
	Evidence           Evidence `json:"evidence"`
	ResolutionNotified bool     `json:"resolution_notified"`
	NightPeriod        string   `json:"night_period,omitempty"`
	NightCount         int      `json:"night_count,omitempty"`
	NightLastRoundAt   string   `json:"night_last_round_at,omitempty"`
	NightEligibleAt    string   `json:"night_eligible_at,omitempty"`
}
type ResponseAudit struct {
	ID         string `json:"id"`
	ResponseID string `json:"response_id"`
	At         string `json:"at"`
	Kind       string `json:"kind"`
	UserID     string `json:"user_id,omitempty"`
	Method     string `json:"method,omitempty"`
	Message    string `json:"message"`
}

func priority(v string) string {
	switch v {
	case "P0", "P1", "P2", "P3":
		return v
	case "critical":
		return "P0"
	default:
		return "P2"
	}
}
func priorityRank(v string) int {
	switch v {
	case "P0":
		return 0
	case "P1":
		return 1
	case "P2":
		return 2
	default:
		return 3
	}
}
func defaultPolicies() map[string]PriorityPolicy {
	return map[string]PriorityPolicy{
		"P0": {Methods: []string{"voice", "sms"}, RepeatSeconds: 120, BackupAfterSeconds: 300, FallbackAfterSeconds: 600, MaxRounds: 6, HandlingSeconds: 1800},
		"P1": {Methods: []string{"voice", "sms"}, Start: "09:00", End: "22:00", NightMode: "after_count", NightMethods: []string{"voice"}, NightAfterCount: 3, RepeatSeconds: 300, BackupAfterSeconds: 600, FallbackAfterSeconds: 1200, MaxRounds: 6, HandlingSeconds: 3600},
		"P2": {Methods: []string{"sms"}, Start: "09:00", End: "22:00", RepeatSeconds: 1800, MaxRounds: 6, HandlingSeconds: 7200},
		"P3": {Methods: []string{"email", "webhook"}, Start: "09:00", End: "18:00", Weekdays: []int{1, 2, 3, 4, 5}, RepeatSeconds: 3600, MaxRounds: 1},
	}
}
func (g Group) policy(p string) PriorityPolicy {
	if v, ok := g.Policies[p]; ok {
		return v
	}
	return legacyPolicies()[priority(p)]
}

// Missing policies in previously saved groups retain their original defaults.
// Only new groups and explicit template selection opt into the new defaults.
func legacyPolicies() map[string]PriorityPolicy {
	p := defaultPolicies()
	p["P0"] = PriorityPolicy{Methods: []string{"voice", "sms", "chat"}, RepeatSeconds: 120, BackupAfterSeconds: 300, FallbackAfterSeconds: 600, MaxRounds: 6, HandlingSeconds: 1800}
	p["P1"] = PriorityPolicy{Methods: []string{"sms", "chat"}, Start: "09:00", End: "22:00", RepeatSeconds: 300, BackupAfterSeconds: 600, FallbackAfterSeconds: 1200, MaxRounds: 6, HandlingSeconds: 3600}
	p["P2"] = PriorityPolicy{Methods: []string{"email", "webhook", "chat"}, Start: "09:00", End: "22:00", RepeatSeconds: 1800, EscalateAfterRounds: 3, EscalateTo: "P1", MaxRounds: 6, HandlingSeconds: 7200}
	return p
}

func (g *Group) fillLegacyPolicies() {
	if len(g.Members) == 0 {
		return
	}
	if g.Policies == nil {
		g.Policies = map[string]PriorityPolicy{}
	}
	for key, p := range legacyPolicies() {
		if _, ok := g.Policies[key]; !ok {
			g.Policies[key] = p
		}
	}
}
func uniqueUsers(v []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, x := range v {
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func (g Group) onCall(now time.Time) OnCallShift {
	s := g.Schedule
	shift := OnCallShift{Primary: g.Primary, Backup: g.Backup}
	if len(s.Shifts) > 0 {
		idx := 0
		if s.Mode != "fixed" {
			loc, _ := time.LoadLocation(s.Timezone)
			if loc == nil {
				loc = time.UTC
			}
			a, n := parse(s.Anchor).In(loc), now.In(loc)
			days := s.IntervalDays
			if s.Mode == "weekly" {
				days = 7
			}
			if s.Mode == "daily" {
				days = 1
			}
			if days < 1 {
				days = 1
			}
			// Local calendar dates, rather than 24-hour durations, preserve DST rotations.
			ad := time.Date(a.Year(), a.Month(), a.Day(), 0, 0, 0, 0, time.UTC)
			nd := time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
			delta := int(nd.Sub(ad).Hours() / 24)
			if n.Hour()*3600+n.Minute()*60+n.Second() < a.Hour()*3600+a.Minute()*60+a.Second() {
				delta--
			}
			if delta >= 0 {
				idx = (delta / days) % len(s.Shifts)
			} else {
				idx = -1
			}
		}
		if idx >= 0 {
			shift = s.Shifts[idx]
		} else {
			shift = OnCallShift{}
		}
	}
	for _, o := range s.Overrides {
		if !now.Before(parse(o.From)) && now.Before(parse(o.Until)) {
			shift = OnCallShift{Primary: o.Primary, Backup: o.Backup}
		}
	}
	filter := func(v []string) []string {
		out := []string{}
		for _, u := range uniqueUsers(v) {
			if includes(g.Members, u) {
				out = append(out, u)
			}
		}
		return out
	}
	shift.Primary, shift.Backup = filter(shift.Primary), filter(shift.Backup)
	return shift
}
func clockMinutes(v string) (int, error) {
	t, e := time.Parse("15:04", v)
	if e != nil {
		return 0, fmt.Errorf("时间必须使用 HH:mm")
	}
	return t.Hour()*60 + t.Minute(), nil
}
func windowAllowed(now time.Time, zone, start, end string, days []int) bool {
	loc, e := time.LoadLocation(zone)
	if e != nil {
		return false
	}
	n := now.In(loc)
	minute := n.Hour()*60 + n.Minute()
	if start == "" && end == "" {
		return len(days) == 0 || includesInt(days, int(n.Weekday()))
	}
	a, ea := clockMinutes(start)
	b, eb := clockMinutes(end)
	if ea != nil || eb != nil {
		return false
	}
	day := int(n.Weekday())
	if a > b && minute < b {
		day = int(n.AddDate(0, 0, -1).Weekday())
	}
	if len(days) > 0 && !includesInt(days, day) {
		return false
	}
	if a == b {
		return true
	}
	if a < b {
		return minute >= a && minute < b
	}
	return minute >= a || minute < b
}
func includesInt(v []int, n int) bool {
	for _, x := range v {
		if x == n {
			return true
		}
	}
	return false
}
func (s Silence) matches(r IncidentResponse) bool {
	if len(s.Priorities) > 0 && !includes(s.Priorities, r.Priority) {
		return false
	}
	for key, value := range s.Labels {
		if r.Event.State.Labels[key] != value {
			return false
		}
	}
	switch s.Scope {
	case "all":
		return true
	case "group":
		return s.GroupID == r.GroupID
	case "rule":
		return s.RuleID == r.RuleID
	case "incident":
		return s.ResponseID == r.ID
	case "service":
		return s.Service != "" && r.Event.State.Labels["service"] == s.Service
	}
	return false
}
func (s Silence) active(now time.Time) bool {
	if !parse(s.From).IsZero() && now.Before(parse(s.From)) {
		return false
	}
	if !parse(s.Until).IsZero() && !now.Before(parse(s.Until)) {
		return false
	}
	if s.DailyStart != "" {
		return windowAllowed(now, s.Timezone, s.DailyStart, s.DailyEnd, s.Weekdays)
	}
	return true
}
func allowedResponse(r IncidentResponse, now time.Time, silences []Silence, ruleSilence string) string {
	if parse(ruleSilence).After(now) {
		return "规则静默"
	}
	for _, s := range silences {
		if s.matches(r) && s.active(now) {
			return "静默：" + s.Reason
		}
	}
	p := r.Group.policy(r.Priority)
	if !windowAllowed(now, r.Group.Timezone, p.Start, p.End, p.Weekdays) {
		if r.nightPeriod(now) != "" {
			switch p.NightMode {
			case "immediate":
				return ""
			case "after_count":
				if r.NightPeriod == r.nightPeriod(now) && r.NightCount >= p.NightAfterCount && r.NightEligibleAt != "" && !now.Before(parse(r.NightEligibleAt)) {
					return ""
				}
				count := 0
				if r.NightPeriod == r.nightPeriod(now) {
					count = r.NightCount
				}
				return fmt.Sprintf("夜间仅记录：持续告警 %d/%d 轮", count, p.NightAfterCount)
			}
		}
		return "通知窗口外"
	}
	return ""
}

// Split at every local minute and every explicit silence boundary. The worker normally
// accounts for one second; the same calculation restores timers after a restart.
func responseActiveSeconds(r IncidentResponse, from, to time.Time, silences []Silence, ruleSilence string) float64 {
	if !to.After(from) {
		return 0
	}
	boundaries := []time.Time{from, to}
	if n := parse(r.NightEligibleAt); n.After(from) && n.Before(to) {
		boundaries = append(boundaries, n)
	}
	for n := from.Truncate(time.Minute).Add(time.Minute); n.Before(to); n = n.Add(time.Minute) {
		boundaries = append(boundaries, n)
	}
	for _, s := range silences {
		for _, v := range []string{s.From, s.Until} {
			n := parse(v)
			if n.After(from) && n.Before(to) {
				boundaries = append(boundaries, n)
			}
		}
	}
	if n := parse(ruleSilence); n.After(from) && n.Before(to) {
		boundaries = append(boundaries, n)
	}
	sort.Slice(boundaries, func(i, j int) bool { return boundaries[i].Before(boundaries[j]) })
	seconds := 0.0
	for i := 1; i < len(boundaries); i++ {
		if allowedResponse(r, boundaries[i-1], silences, ruleSilence) == "" {
			seconds += boundaries[i].Sub(boundaries[i-1]).Seconds()
		}
	}
	return seconds
}
