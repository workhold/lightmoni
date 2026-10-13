package alerts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	"math/big"
	"strings"
	"time"
)

func fingerprint(labels map[string]string) string {
	v := sha256.Sum256([]byte(encode(labels)))
	return hex.EncodeToString(v[:])
}
func (m *Module) inspect(ctx context.Context, r Rule, now time.Time) (Preview, error) {
	to := now.Add(-time.Duration(r.DelaySeconds) * time.Second)
	from := to.Add(-time.Duration(r.WindowSeconds) * time.Second)
	p := Preview{States: []State{}, Range: shared.Range{From: stamp(from), To: stamp(to)}}
	routes, warnings, e := m.route(ctx, r)
	if e != nil {
		return p, e
	}
	p.Routes = routes
	p.Warnings = warnings
	qctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	response, e := m.deps.Query(qctx, shared.QueryRequest{RequestID: id(), Range: p.Range, IntervalMS: int64(r.IntervalSeconds) * 1000, Source: "alert", Queries: []shared.Query{{RefID: "A", SQL: r.SQL, Params: r.Params}}})
	p.Result = response
	if e != nil {
		p.States = append(p.States, State{RuleID: r.ID, Labels: map[string]string{}, Health: "error", Error: e.Error()})
		return p, nil
	}
	if len(response.Results) != 1 {
		return p, errors.New("invalid query result count")
	}
	result := response.Results[0]
	if result.Status == "error" || !result.Complete || result.Truncated {
		message := result.Error
		if message == "" {
			message = "query incomplete/truncated"
		}
		p.States = append(p.States, State{RuleID: r.ID, Labels: map[string]string{}, Health: "error", Error: message})
		return p, nil
	}
	seen := map[string]bool{}
	for _, frame := range result.Frames {
		ci := map[string]int{}
		for i, c := range frame.Columns {
			ci[c.Name] = i
		}
		vi, ok := ci[r.ValueField]
		if !ok && len(frame.Rows) > 0 {
			return p, fmt.Errorf("numeric field %s not found", r.ValueField)
		}
		if ok && len(frame.Rows) > 0 && !numericType(frame.Columns[vi].Type) {
			return p, fmt.Errorf("field %s has non-numeric type %s", r.ValueField, frame.Columns[vi].Type)
		}
		for _, row := range frame.Rows {
			labels := map[string]string{}
			typedLabels := map[string]any{}
			for _, name := range r.LabelFields {
				j, ok := ci[name]
				if !ok || j >= len(row) {
					return p, fmt.Errorf("label field %s missing", name)
				}
				labels[name] = fmt.Sprint(row[j])
				typedLabels[name] = []any{frame.Columns[j].Type, row[j]}
			}
			fp := fingerprint(labels)
			if len(r.LabelFields) > 0 {
				v := sha256.Sum256([]byte(encode(typedLabels)))
				fp = hex.EncodeToString(v[:])
			}
			if seen[fp] {
				return p, errors.New("duplicate label combination; aggregate in SQL")
			}
			seen[fp] = true
			state := State{RuleID: r.ID, Fingerprint: fp, Labels: labels, Health: "ok", Status: "normal"}
			if vi >= len(row) || row[vi] == nil {
				state.Health = "no_data"
			} else {
				state.Value = fmt.Sprint(row[vi])
				if _, ok := new(big.Rat).SetString(state.Value); !ok {
					return p, errors.New("query value must be finite numeric")
				}
				if breached(state.Value, r.Threshold, r.Operator) {
					state.Status = "firing"
				}
			}
			p.States = append(p.States, state)
			if len(p.States) > 1000 {
				return p, errors.New("alert instance limit exceeded")
			}
		}
	}
	if len(p.States) == 0 {
		p.States = append(p.States, State{RuleID: r.ID, Fingerprint: fingerprint(map[string]string{}), Labels: map[string]string{}, Health: "no_data", Status: "normal"})
	}
	if r.Operator == "no_data" {
		for i := range p.States {
			state := &p.States[i]
			// The generated chart query returns the number of real, non-null points.
			if state.Health == "no_data" || state.Health == "ok" && breached(state.Value, "0", "eq") {
				state.Health, state.Status, state.Value = "ok", "firing", "0"
			}
		}
	}
	for i := range p.States {
		p.States[i] = applyNoDataPolicy(p.States[i], r)
	}
	return p, nil
}

// Apply only to a successful query with no value. Query failures retain their
// separate health state and must never be substituted with a numeric value.
func applyNoDataPolicy(s State, r Rule) State {
	if s.Health != "no_data" || r.Operator == "no_data" {
		return s
	}
	s.missing = true
	switch r.NoDataPolicy {
	case "zero", "value":
		s.Value = "0"
		if r.NoDataPolicy == "value" {
			s.Value = r.NoDataValue
		}
		s.Health, s.Status = "ok", "normal"
		if breached(s.Value, r.Threshold, r.Operator) {
			s.Status = "firing"
		}
	case "alerting":
		s.Health, s.Status = "ok", "firing"
	case "normal":
		s.Health, s.Status = "ok", "normal"
	}
	return s
}
func numericType(typ string) bool {
	for strings.HasPrefix(typ, "Nullable(") || strings.HasPrefix(typ, "LowCardinality(") {
		start := strings.IndexByte(typ, '(')
		if !strings.HasSuffix(typ, ")") {
			return false
		}
		typ = typ[start+1 : len(typ)-1]
	}
	return strings.HasPrefix(typ, "UInt") || strings.HasPrefix(typ, "Int") || strings.HasPrefix(typ, "Float") || strings.HasPrefix(typ, "Decimal")
}
func breached(value, threshold, op string) bool {
	v, ok := new(big.Rat).SetString(value)
	if !ok {
		return false
	}
	t, ok := new(big.Rat).SetString(threshold)
	if !ok {
		return false
	}
	c := v.Cmp(t)
	switch op {
	case "gt":
		return c > 0
	case "gte":
		return c >= 0
	case "lt":
		return c < 0
	case "lte":
		return c <= 0
	case "eq":
		return c == 0
	case "ne":
		return c != 0
	}
	return false
}
func elapsed(now time.Time, s string, seconds int) bool {
	return !parse(s).IsZero() && now.Sub(parse(s)) >= time.Duration(seconds)*time.Second
}
func transition(old, in State, r Rule, now time.Time) (State, []string) {
	s := old
	s.RuleID = r.ID
	s.Fingerprint = in.Fingerprint
	s.Labels = in.Labels
	s.Value = in.Value
	s.Error = in.Error
	events := []string{}
	if s.Status == "" {
		s.Status = "normal"
	}
	gap := old.Health != "ok" || (!parse(old.LastEval).IsZero() && now.Sub(parse(old.LastEval)) > time.Duration(r.IntervalSeconds*2)*time.Second)
	if in.Health != "ok" {
		if old.Health != in.Health {
			s.HealthSince = stamp(now)
		}
		if s.Status == "pending" {
			s.Status = "normal"
			s.Since = ""
		}
		if s.Status == "recovering" {
			s.Status = "firing"
			s.Since = ""
		}
		s.Health = in.Health
		if r.NotifyHealth && s.HealthEpisode == "" && elapsed(now, s.HealthSince, r.HealthForSeconds) {
			s.HealthEpisode = id()
			events = append(events, in.Health)
		}
		s.LastEval = stamp(now)
		return s, events
	}
	if s.HealthEpisode != "" {
		events = append(events, "health_resolved")
		s.HealthEpisode = ""
	}
	s.Health = "ok"
	s.HealthSince = ""
	if !in.missing {
		s.LastSuccess = stamp(now)
	}
	if in.Status == "firing" {
		if s.Status != "firing" {
			if s.Status != "pending" || gap {
				s.Since = stamp(now)
			}
			s.Status = "pending"
			if s.Episode != "" {
				s.Status = "firing"
			} else if elapsed(now, s.Since, r.ForSeconds) {
				s.Status = "firing"
				s.Episode = id()
				events = append(events, "firing")
				s.LastNotify = stamp(now)
			}
		} else if r.RepeatSeconds > 0 && elapsed(now, s.LastNotify, r.RepeatSeconds) {
			events = append(events, "reminder")
			s.LastNotify = stamp(now)
		}
	} else {
		if s.Episode != "" {
			if s.Status != "recovering" || gap {
				s.Since = stamp(now)
			}
			s.Status = "recovering"
			if elapsed(now, s.Since, r.RecoverySeconds) {
				events = append(events, "resolved")
				s.Status = "normal"
				s.Since = ""
			}
		} else {
			s.Status = "normal"
			s.Since = ""
		}
	}
	s.LastEval = stamp(now)
	return s, events
}
func (m *Module) Evaluate(ctx context.Context, r Rule, now time.Time) error {
	responseGroups, err := m.ruleResponseGroups(ctx, r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p, e := m.inspect(ctx, r, now)
	if e != nil {
		p.States = []State{{RuleID: r.ID, Fingerprint: fingerprint(map[string]string{}), Labels: map[string]string{}, Health: "error", Error: e.Error()}}
		p.Warnings = append(p.Warnings, e.Error())
	}
	olds, e := listBodies[State](ctx, m.deps.DB, "SELECT body FROM alert_states WHERE rule_id=?", r.ID)
	if e != nil {
		return e
	}
	oldMap := map[string]State{}
	for _, s := range olds {
		oldMap[s.Fingerprint] = s
	}
	incoming := map[string]State{}
	globalError := ""
	for _, s := range p.States {
		if s.Fingerprint == "" {
			s.Fingerprint = fingerprint(s.Labels)
		}
		incoming[s.Fingerprint] = s
		if s.Health == "error" {
			globalError = s.Error
		}
	}
	if globalError != "" && len(olds) > 0 {
		incoming = map[string]State{}
	}
	if len(olds) > 0 && len(p.States) == 1 && (p.States[0].missing || p.States[0].Health == "no_data" || r.Operator == "no_data" && p.States[0].Status == "firing") && len(p.States[0].Labels) == 0 && len(r.LabelFields) > 0 {
		// A completely empty grouped query marks its known instances missing.
		// It must not invent another instance with no dimension values.
		incoming = map[string]State{}
	}
	hasGroupedData := false
	for _, in := range incoming {
		if len(in.Labels) > 0 && in.Health != "error" {
			hasGroupedData = true
		}
	}
	for _, old := range olds {
		if _, ok := incoming[old.Fingerprint]; !ok {
			health := "no_data"
			if globalError != "" {
				health = "error"
			}
			incoming[old.Fingerprint] = State{RuleID: r.ID, Fingerprint: old.Fingerprint, Labels: old.Labels, Health: health, Error: globalError}
			if r.Operator == "no_data" && health == "no_data" {
				incoming[old.Fingerprint] = State{RuleID: r.ID, Fingerprint: old.Fingerprint, Labels: old.Labels, Health: "ok", Status: "firing", Value: "0"}
			}
			incoming[old.Fingerprint] = applyNoDataPolicy(incoming[old.Fingerprint], r)
			if globalError == "" && len(old.Labels) == 0 && len(r.LabelFields) > 0 && hasGroupedData {
				// Retire the initial whole-query absence once actual lines appear.
				incoming[old.Fingerprint] = State{RuleID: r.ID, Fingerprint: old.Fingerprint, Labels: old.Labels, Health: "ok", Status: "normal", Value: "1"}
			}
		}
	}
	tx, e := m.deps.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	var currentRaw string
	if e = tx.QueryRow("SELECT body FROM alert_rules WHERE id=?", r.ID).Scan(&currentRaw); e != nil {
		return e
	}
	var current Rule
	_ = json.Unmarshal([]byte(currentRaw), &current)
	if current.Revision != r.Revision || !current.Enabled {
		return nil
	}
	for fp, in := range incoming {
		old := oldMap[fp]
		state, kinds := transition(old, in, r, now)
		state.Silenced = parse(current.SilenceUntil).After(now)
		if old.Silenced && !state.Silenced && (state.Status == "firing" || state.HealthEpisode != "") {
			kinds = append(kinds, "reminder")
			state.LastNotify = stamp(now)
		}
		for _, kind := range kinds {
			episode := state.Episode
			if kind == "health_resolved" {
				episode = old.HealthEpisode
			} else if kind == "no_data" || kind == "error" {
				episode = state.HealthEpisode
			}
			event := Event{ID: id(), RuleID: r.ID, RuleName: r.Name, RuleRevision: r.Revision, Range: p.Range, Kind: kind, Episode: episode, CreatedAt: stamp(now), State: state, SourceTableIDs: r.SourceTableIDs}
			for _, g := range responseGroups {
				if !includes(event.GroupIDs, g.ID) {
					event.GroupIDs = append(event.GroupIDs, g.ID)
				}
			}
			event.Message = fmt.Sprintf("%s · %s\n数值 %s · 阈值 %s %s\n%s\n窗口 [%s, %s)", r.Name, kind, state.Value, r.Operator, r.Threshold, encode(state.Labels), p.Range.From, p.Range.To)
			if in.missing && r.NoDataPolicy != "" && r.NoDataPolicy != "keep_state" {
				description := map[string]string{"zero": "按 0 计算", "value": "按指定值计算", "alerting": "视为告警", "normal": "视为正常"}[r.NoDataPolicy]
				event.Message += "\n窗口无数据 · " + description
			}
			if r.Operator == "no_data" {
				event.Message = fmt.Sprintf("%s · %s\n%d 秒内没有打点 · 当前点数 %s\n%s\n窗口 [%s, %s)", r.Name, kind, r.WindowSeconds, state.Value, encode(state.Labels), p.Range.From, p.Range.To)
			}
			if len(p.Warnings) > 0 {
				event.Message += "\n" + strings.Join(p.Warnings, "; ")
			}
			for _, route := range p.Routes {
				var queued int
				if e = tx.QueryRow("SELECT count(*) FROM alert_outbox WHERE status IN ('queued','retry','sending')").Scan(&queued); e != nil {
					return e
				}
				if queued >= 10000 {
					return errors.New("notification queue capacity reached")
				}
				for _, gid := range route.GroupIDs {
					if !includes(event.GroupIDs, gid) {
						event.GroupIDs = append(event.GroupIDs, gid)
					}
				}
			}
			if _, e = tx.Exec("INSERT INTO alert_events(id,rule_id,created_at,body) VALUES(?,?,?,?)", event.ID, r.ID, event.CreatedAt, encode(event)); e != nil {
				return e
			}
			if e = m.syncResponsesTx(tx, event, r, responseGroups); e != nil {
				return e
			}
			for _, route := range p.Routes {
				if m.managedRoute(route, responseGroups) {
					continue
				}
				status := "queued"
				if parse(current.SilenceUntil).After(now) {
					status = "suppressed"
				}
				d := Delivery{ID: id(), EventID: event.ID, RuleID: r.ID, GroupIDs: route.GroupIDs, TableIDs: r.SourceTableIDs, ChannelID: route.Target.ChannelID, Recipient: route.Target.Recipient, Status: status, CreatedAt: stamp(now), UpdatedAt: stamp(now), NextAttempt: stamp(now), Payload: event}
				if _, e = tx.Exec("INSERT OR IGNORE INTO alert_outbox(id,event_id,channel_id,target,status,next_attempt,created_at,body) VALUES(?,?,?,?,?,?,?,?)", d.ID, d.EventID, d.ChannelID, recipientKey(d.Recipient), d.Status, d.NextAttempt, d.CreatedAt, encode(d)); e != nil {
					return e
				}
			}
		}
		if includes(kinds, "resolved") {
			state.Episode = ""
		}
		if len(r.LabelFields) > 0 && len(in.Labels) == 0 && hasGroupedData && state.Status == "normal" {
			if _, e = tx.Exec("DELETE FROM alert_states WHERE rule_id=? AND fingerprint=?", r.ID, fp); e != nil {
				return e
			}
			continue
		}
		if _, e = tx.Exec("INSERT INTO alert_states(rule_id,fingerprint,body) VALUES(?,?,?) ON CONFLICT(rule_id,fingerprint) DO UPDATE SET body=excluded.body", r.ID, fp, encode(state)); e != nil {
			return e
		}
	}
	if _, e = tx.Exec("UPDATE alert_rules SET last_eval=? WHERE id=?", stamp(now), r.ID); e != nil {
		return e
	}
	return tx.Commit()
}
func (m *Module) Run(ctx context.Context) {
	// A sending worker that died after its request began has an unknown provider outcome.
	_, _ = m.deps.DB.ExecContext(ctx, "UPDATE alert_outbox SET status='unknown' WHERE status='sending'")
	states, _ := listBodies[State](ctx, m.deps.DB, "SELECT body FROM alert_states")
	for _, s := range states {
		if s.Status == "pending" {
			s.Status = "normal"
			s.Since = ""
		}
		if s.Status == "recovering" {
			s.Status = "firing"
			s.Since = ""
		}
		if s.Health != "ok" {
			s.HealthSince = stamp(m.now())
		}
		_, _ = m.deps.DB.ExecContext(ctx, "UPDATE alert_states SET body=? WHERE rule_id=? AND fingerprint=?", encode(s), s.RuleID, s.Fingerprint)
	}
	workerDone := make(chan struct{})
	directoryDone := make(chan struct{})
	go func() {
		defer close(directoryDone)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = m.SyncDueDirectories(ctx)
			}
		}
	}()
	go func() {
		defer close(workerDone)
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = m.ProcessVoiceReceipts(ctx)
				_ = m.CollectPendingEvidence(ctx)
				_ = m.TickResponses(ctx)
				_ = m.NotifyResolved(ctx)
				_ = m.SendPending(ctx)
			}
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			<-workerDone
			<-directoryDone
			return
		case <-ticker.C:
			rules, e := m.rules(ctx)
			if e == nil {
				for _, r := range rules {
					if !r.Enabled {
						continue
					}
					var last string
					_ = m.deps.DB.QueryRowContext(ctx, "SELECT last_eval FROM alert_rules WHERE id=?", r.ID).Scan(&last)
					now := m.now()
					if last == "" || now.Sub(parse(last)) >= time.Duration(r.IntervalSeconds)*time.Second {
						_ = m.Evaluate(ctx, r, now)
					}
				}
			}
		}
	}
}
