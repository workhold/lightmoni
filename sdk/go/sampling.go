package moni

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"
	"hash/fnv"
	"io"
	"math"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"
)

var ErrInvalidSampling = errors.New("invalid log reporting rules")

type LogCondition struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Values   []any  `json:"values,omitempty"`
}
type LogRule struct {
	Name       string         `json:"name"`
	Rate       float64        `json:"rate"`
	Conditions []LogCondition `json:"conditions"`
}
type LogExcludeRule struct {
	Name       string         `json:"name"`
	Conditions []LogCondition `json:"conditions"`
}
type LogSamplingPolicy struct {
	Key     string           `json:"key"`
	Rules   []LogRule        `json:"rules"`
	Exclude []LogExcludeRule `json:"exclude"`
}
type SDKConfig struct {
	MetricWindows map[string][]MetricWindow    `json:"metric_windows,omitempty"`
	Revision      string                       `json:"revision"`
	LogSampling   map[string]LogSamplingPolicy `json:"log_sampling"`
	DisableRules  []LogExcludeRule             `json:"disable_rules"`
}

func DefaultLogSampling() LogSamplingPolicy {
	return LogSamplingPolicy{Key: "event_id", Rules: []LogRule{{Name: "all", Rate: 1, Conditions: []LogCondition{}}}, Exclude: []LogExcludeRule{}}
}

func decodeStrict(reader io.Reader, v any) error {
	decoder := json.NewDecoder(reader)
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("expected one JSON object")
	}
	return nil
}
func (r *LogRule) UnmarshalJSON(raw []byte) error {
	var input struct {
		Name       string          `json:"name"`
		Rate       *float64        `json:"rate"`
		Conditions *[]LogCondition `json:"conditions"`
	}
	if err := decodeStrict(strings.NewReader(string(raw)), &input); err != nil {
		return err
	}
	if input.Rate == nil || input.Conditions == nil {
		return fmt.Errorf("%w: rule requires rate and conditions", ErrInvalidSampling)
	}
	*r = LogRule{Name: input.Name, Rate: *input.Rate, Conditions: *input.Conditions}
	return nil
}
func (p *LogSamplingPolicy) UnmarshalJSON(raw []byte) error {
	var input struct {
		Key     string           `json:"key"`
		Rules   *[]LogRule       `json:"rules"`
		Exclude []LogExcludeRule `json:"exclude"`
	}
	if err := decodeStrict(strings.NewReader(string(raw)), &input); err != nil {
		return err
	}
	if input.Rules == nil {
		return fmt.Errorf("%w: rules is required; [] ignores all business logs", ErrInvalidSampling)
	}
	if input.Key == "" {
		input.Key = "event_id"
	}
	if input.Exclude == nil {
		input.Exclude = []LogExcludeRule{}
	}
	*p = LogSamplingPolicy{Key: input.Key, Rules: *input.Rules, Exclude: input.Exclude}
	return p.Validate()
}
func samplingField(field string) bool {
	if len(field) > 136 || strings.ContainsRune(field, '\x00') {
		return false
	}
	switch field {
	case "event_id", "service", "severity", "trace_id", "instance_id", "sdk.language":
		return true
	}
	return strings.HasPrefix(field, "attr:") && len(field) > 5 || strings.HasPrefix(field, "resource:") && len(field) > 9
}
func scalarKey(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return "s:" + x, true
	case bool:
		return "b:" + strconv.FormatBool(x), true
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return "n:" + strconv.FormatInt(n, 10), true
		}
		if n, err := x.Float64(); err == nil {
			return scalarKey(n)
		}
	}
	if v != nil {
		x := reflect.ValueOf(v)
		switch x.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return "n:" + strconv.FormatInt(x.Int(), 10), true
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return "n:" + strconv.FormatUint(x.Uint(), 10), true
		case reflect.Float32, reflect.Float64:
			n := x.Float()
			if !math.IsNaN(n) && !math.IsInf(n, 0) {
				return "n:" + strconv.FormatFloat(n, 'f', -1, 64), true
			}
		}
	}
	return "", false
}
func (p LogSamplingPolicy) Validate() error {
	bad := func(message string) error { return fmt.Errorf("%w: %s", ErrInvalidSampling, message) }
	if !samplingField(p.Key) {
		return bad("invalid sampling key")
	}
	if p.Rules == nil || len(p.Rules) > 32 {
		return bad("rules must be an array of at most 32 rules")
	}
	if err := ValidateExcludeRules(p.Exclude, false); err != nil {
		return err
	}
	for _, r := range p.Rules {
		if len(r.Name) > 64 || math.IsNaN(r.Rate) || math.IsInf(r.Rate, 0) || r.Rate < 0 || r.Rate > 1 || r.Rate > 0 && r.Rate < 0.000001 {
			return bad("rule rate must be zero or between 0.000001 and 1; name <=64 bytes")
		}
		if r.Conditions == nil || len(r.Conditions) > 8 {
			return bad("conditions must be an array of at most 8 conditions")
		}
		for _, c := range r.Conditions {
			if !samplingField(c.Field) {
				return bad("invalid rule field")
			}
			switch c.Operator {
			case "exists":
				if len(c.Values) != 0 {
					return bad("exists requires no values")
				}
			case "in":
				if len(c.Values) == 0 || len(c.Values) > 256 {
					return bad("in requires 1 to 256 scalar values")
				}
				for _, v := range c.Values {
					if _, ok := scalarKey(v); !ok {
						return bad("only string, boolean and finite numeric values are supported")
					}
				}
			default:
				return bad("operator must be in or exists")
			}
		}
	}
	raw, err := json.Marshal(p)
	if err != nil || len(raw) > 64<<10 {
		return bad("policy exceeds 64 KiB")
	}
	return nil
}
func ValidateExcludeRules(rules []LogExcludeRule, sdk bool) error {
	if len(rules) > 32 {
		return fmt.Errorf("%w: at most 32 exclusion rules", ErrInvalidSampling)
	}
	for _, rule := range rules {
		if len(rule.Conditions) == 0 {
			return fmt.Errorf("%w: exclusions require a condition", ErrInvalidSampling)
		}
		if sdk {
			for _, c := range rule.Conditions {
				if c.Field != "service" && c.Field != "instance_id" && c.Field != "sdk.language" && !strings.HasPrefix(c.Field, "resource:") {
					return fmt.Errorf("%w: SDK selectors require service, instance_id, sdk.language or resource:field", ErrInvalidSampling)
				}
			}
		}
		p := LogSamplingPolicy{Key: "event_id", Rules: []LogRule{{Name: rule.Name, Rate: 1, Conditions: rule.Conditions}}}
		if err := p.Validate(); err != nil {
			return err
		}
	}
	return nil
}
func DecodeLogSampling(reader io.Reader) (LogSamplingPolicy, error) {
	var policy LogSamplingPolicy
	if err := decodeStrict(io.LimitReader(reader, (64<<10)+1), &policy); err != nil {
		return policy, fmt.Errorf("%w: %v", ErrInvalidSampling, err)
	}
	return policy, nil
}
func DecodeSDKConfig(reader io.Reader) (SDKConfig, error) {
	var config SDKConfig
	if err := decodeStrict(io.LimitReader(reader, (1<<20)+1), &config); err != nil {
		return config, err
	}
	if config.Revision == "" || len(config.Revision) > 128 || config.LogSampling == nil || len(config.LogSampling) > 200 {
		return config, errors.New("invalid SDK configuration")
	}
	if err := validMetricWindows(config.MetricWindows); err != nil {
		return config, err
	}
	for table, policy := range config.LogSampling {
		if !validTable(table) || systemSamplingTable(table) {
			return config, errors.New("invalid log policy table")
		}
		if err := policy.Validate(); err != nil {
			return config, err
		}
	}
	if err := ValidateExcludeRules(config.DisableRules, true); err != nil {
		return config, err
	}
	return config, nil
}
func systemSamplingTable(table string) bool {
	return table == "lightmoni"
}

func logField(field string, record, attrs, resource Attributes) (any, bool) {
	var values Attributes
	key := field
	if strings.HasPrefix(field, "attr:") {
		values = attrs
		key = field[5:]
	} else if strings.HasPrefix(field, "resource:") {
		values = resource
		key = field[9:]
	} else {
		values = record
	}
	v, ok := values[key]
	if field == "trace_id" && v == "" {
		return v, false
	}
	return v, ok && v != nil
}

// Conditions within a rule are ANDed. Rules are ORed, with the highest matched
// rate winning, so a general rule cannot reduce a QA/VIP rule's full coverage.
func (p LogSamplingPolicy) decide(table string, record, attrs, resource Attributes) (bool, float64, string) {
	for _, rule := range p.Exclude {
		if conditionsMatch(rule.Conditions, record, attrs, resource) {
			return false, 0, "excluded"
		}
	}
	rate := -1.0
	reason := "unmatched"
	for _, rule := range p.Rules {
		matched := true
		for _, condition := range rule.Conditions {
			value, exists := logField(condition.Field, record, attrs, resource)
			match := exists
			if condition.Operator == "in" {
				match = false
				key, scalar := scalarKey(value)
				if exists && scalar {
					for _, expected := range condition.Values {
						if other, ok := scalarKey(expected); ok && other == key {
							match = true
							break
						}
					}
				}
			}
			if !match {
				matched = false
				break
			}
		}
		if matched && rule.Rate > rate {
			rate = rule.Rate
			reason = rule.Name
			if reason == "" {
				reason = "matched"
			}
		}
	}
	if rate <= 0 {
		return false, 0, reason
	}
	value, exists := logField(p.Key, record, attrs, resource)
	key, scalar := scalarKey(value)
	field := p.Key
	if !exists || !scalar || value == "" {
		field = "event_id"
		key, _ = scalarKey(record["event_id"])
	}
	hash := fnv.New32a()
	_, _ = hash.Write([]byte("lightmoni-log-rules\x00" + table + "\x00" + field + "\x00" + key))
	// Avalanche the bits before applying a threshold: raw FNV high bits are
	// biased for short sequential UID strings with the same prefix.
	valueHash := hash.Sum32()
	valueHash ^= valueHash >> 16
	valueHash *= 0x85ebca6b
	valueHash ^= valueHash >> 13
	valueHash *= 0xc2b2ae35
	valueHash ^= valueHash >> 16
	return float64(valueHash)/(1<<32) < rate, rate, reason
}
func conditionsMatch(conditions []LogCondition, record, attrs, resource Attributes) bool {
	for _, c := range conditions {
		v, exists := logField(c.Field, record, attrs, resource)
		if !exists {
			return false
		}
		if c.Operator == "in" {
			matched := false
			k, scalar := scalarKey(v)
			for _, expected := range c.Values {
				if other, ok := scalarKey(expected); ok && scalar && other == k {
					matched = true
					break
				}
			}
			if !matched {
				return false
			}
		}
	}
	return true
}

// UpdateLogSampling swaps an immutable snapshot. It only changes future Log
// calls, never buffered records, metric windows, spans or frozen retries.
func (c *Client) UpdateLogSampling(policies map[string]LogSamplingPolicy) error {
	copy := map[string]LogSamplingPolicy{}
	for table, policy := range policies {
		if !validTable(table) || systemSamplingTable(table) {
			return errors.New("invalid log policy table")
		}
		raw, err := json.Marshal(policy)
		if err != nil {
			return err
		}
		var snapshot LogSamplingPolicy
		if err = json.Unmarshal(raw, &snapshot); err != nil {
			return err
		}
		copy[table] = snapshot
	}
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	if c.s.closing {
		return errors.New("SDK is closed")
	}
	c.s.localSampling = copy
	return nil
}

func (c *Client) RefreshConfig(ctx context.Context) error {
	s := c.s
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.ctx, cancel)
	defer func() { stop(); cancel() }()
	s.configMu.Lock()
	defer s.configMu.Unlock()
	s.mu.Lock()
	endpoint, key := s.cfg.ConfigEndpoint, s.configKey
	if s.cfg.ConfigKey != "" {
		key = s.cfg.ConfigKey
	}
	closed := s.closing
	s.mu.Unlock()
	if endpoint == "" || closed {
		return errors.New("SDK remote configuration is disabled or closed")
	}
	if exporter, ok := s.cfg.Exporter.(*HTTPExporter); ok && endpoint == s.cfg.Endpoint {
		var err error
		endpoint, err = exporter.endpoints.resolve(ctx, exporter.Client, key, false)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(endpoint, "/")+"/v1/sdk-config", nil)
	if err != nil {
		return err
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		if exporter, ok := s.cfg.Exporter.(*HTTPExporter); ok && centerTransportFailure(err) {
			exporter.endpoints.failure(endpoint)
		}
		return errors.New("SDK configuration endpoint unreachable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("SDK configuration HTTP %d", resp.StatusCode)
	}
	if exporter, ok := s.cfg.Exporter.(*HTTPExporter); ok && s.cfg.ConfigEndpoint == s.cfg.Endpoint {
		resp.Body = &centerResponseBody{resp.Body, exporter.endpoints, endpoint}
	}
	config, err := DecodeSDKConfig(resp.Body)
	if err != nil {
		return fmt.Errorf("invalid SDK configuration: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return errors.New("SDK is closed")
	}
	s.metricWindows = config.MetricWindows
	s.remoteSampling = config.LogSampling
	s.stats.ConfigRevision = config.Revision
	s.stats.ConfigError = ""
	disabled := false
	record := Attributes{"service": s.cfg.Service, "instance_id": s.instance, "sdk.language": "go"}
	resource := Attributes{}
	for _, a := range s.resource.Attributes {
		resource[a.Key] = samplingAttribute(a.Value)
	}
	for _, rule := range config.DisableRules {
		if conditionsMatch(rule.Conditions, record, nil, resource) {
			disabled = true
			break
		}
	}
	s.remoteDisabled = disabled
	s.setReportingDisabledLocked(disabled || s.localDisabled)
	return nil
}
func (c *Client) SetReportingEnabled(enabled bool) {
	c.s.mu.Lock()
	defer c.s.mu.Unlock()
	c.s.localDisabled = !enabled
	c.s.setReportingDisabledLocked(!enabled || c.s.remoteDisabled)
}
func (s *state) setReportingDisabledLocked(disabled bool) {
	if s.reportingDisabled == disabled {
		return
	}
	s.reportingDisabled = disabled
	s.stats.ReportingDisabled = disabled
	if disabled {
		s.reportingGeneration++
		if s.deliveryCancel != nil {
			s.deliveryCancel()
		}
		for _, rows := range s.logs {
			s.stats.DisabledRecords += uint64(len(rows))
		}
		for _, rows := range s.spans {
			s.stats.DisabledRecords += uint64(len(rows))
		}
		for _, m := range s.metrics {
			s.stats.DisabledRecords += uint64(len(m.series))
			m.series = map[string]*measurement{}
			m.start = time.Now()
		}
		for _, q := range s.queue {
			s.stats.DisabledRecords += uint64(q.records)
		}
		s.observations = map[string]*observation{}
		s.logs = map[string][]*logpb.LogRecord{}
		s.spans = map[string][]*tracepb.Span{}
		s.queue = nil
		s.bufferBytes = 0
		s.stats.PendingBatches = 0
		s.stats.PendingBytes = 0
	} else {
		s.selfLast = time.Time{}
		for _, m := range s.metrics {
			m.start = time.Now()
		}
	}
	s.notifyLocked()
	select {
	case s.retryNow <- struct{}{}:
	default:
	}
}
func (s *state) configLoop() {
	defer close(s.configDone)
	if s.cfg.DisableRemoteConfig || s.cfg.ConfigEndpoint == "" {
		return
	}
	ticker := time.NewTicker(s.cfg.ConfigInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
			err := (&Client{s: s, table: s.cfg.Table}).RefreshConfig(ctx)
			cancel()
			if err != nil && s.ctx.Err() == nil {
				s.mu.Lock()
				s.stats.ConfigError = err.Error()
				s.mu.Unlock()
			}
		}
	}
}
