package alerts

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/shared"
	"net/http"
	"sync"
	"time"
)

type Recipient struct {
	Kind     string   `json:"kind"`
	Value    string   `json:"value"`
	Mentions []string `json:"mentions,omitempty"`
}
type Target struct {
	ChannelID string    `json:"channel_id"`
	Recipient Recipient `json:"recipient"`
}
type Group struct {
	ID         string                    `json:"id"`
	Name       string                    `json:"name"`
	Enabled    bool                      `json:"enabled"`
	Targets    []Target                  `json:"targets"`
	Revision   int                       `json:"revision"`
	Members    []string                  `json:"members"`
	Primary    []string                  `json:"primary"`
	Backup     []string                  `json:"backup"`
	Fallback   []string                  `json:"fallback"`
	Timezone   string                    `json:"timezone"`
	ChannelIDs []string                  `json:"channel_ids"`
	Schedule   OnCallSchedule            `json:"schedule"`
	Policies   map[string]PriorityPolicy `json:"policies"`
}
type Channel struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Enabled   bool              `json:"enabled"`
	Config    map[string]string `json:"config"`
	HasSecret bool              `json:"has_secret"`
	Revision  int               `json:"revision"`
}
type Rule struct {
	Unit             string                      `json:"unit,omitempty"`
	Kind             string                      `json:"kind"`
	ID               string                      `json:"id"`
	Name             string                      `json:"name"`
	Enabled          bool                        `json:"enabled"`
	Revision         int                         `json:"revision"`
	SQL              string                      `json:"sql"`
	SourceTableIDs   []string                    `json:"source_table_ids"`
	GroupIDs         []string                    `json:"group_ids,omitempty"`
	PanelCondition   *PanelCondition             `json:"panel_condition,omitempty"`
	Services         []string                    `json:"services"`
	Params           map[string]shared.Parameter `json:"params,omitempty"`
	ValueField       string                      `json:"value_field"`
	LabelFields      []string                    `json:"label_fields"`
	Operator         string                      `json:"operator"`
	Threshold        string                      `json:"threshold"`
	IntervalSeconds  int                         `json:"interval_seconds"`
	WindowSeconds    int                         `json:"window_seconds"`
	DelaySeconds     int                         `json:"delay_seconds"`
	NoDataPolicy     string                      `json:"no_data_policy,omitempty"`
	NoDataValue      string                      `json:"no_data_value,omitempty"`
	ForSeconds       int                         `json:"for_seconds"`
	RecoverySeconds  int                         `json:"recovery_seconds"`
	RepeatSeconds    int                         `json:"repeat_seconds"`
	HealthForSeconds int                         `json:"health_for_seconds"`
	NotifyHealth     bool                        `json:"notify_health"`
	Severity         string                      `json:"severity"`
	SilenceUntil     string                      `json:"silence_until,omitempty"`
	EvidenceProfile  *EvidenceProfile            `json:"evidence_profile,omitempty"`
}

// PanelCondition keeps the chart selection editable without exposing generated SQL.
type PanelCondition struct {
	PanelID  string            `json:"panel_id"`
	QueryRef string            `json:"query_ref"`
	Series   *shared.Parameter `json:"series,omitempty"`
	Reducer  string            `json:"reducer"`
}
type State struct {
	// Only used during evaluation to distinguish a substitute from real data.
	missing       bool
	RuleID        string            `json:"rule_id"`
	Fingerprint   string            `json:"fingerprint"`
	Labels        map[string]string `json:"labels"`
	Status        string            `json:"status"`
	Health        string            `json:"health"`
	Value         string            `json:"value"`
	Since         string            `json:"since"`
	HealthSince   string            `json:"health_since"`
	LastEval      string            `json:"last_eval"`
	LastSuccess   string            `json:"last_success"`
	LastNotify    string            `json:"last_notify"`
	Episode       string            `json:"episode"`
	HealthEpisode string            `json:"health_episode"`
	Error         string            `json:"error,omitempty"`
	Silenced      bool              `json:"silenced"`
}
type Event struct {
	ID             string       `json:"id"`
	RuleID         string       `json:"rule_id"`
	RuleName       string       `json:"rule_name"`
	RuleRevision   int          `json:"rule_revision"`
	Kind           string       `json:"kind"`
	Episode        string       `json:"episode"`
	CreatedAt      string       `json:"created_at"`
	State          State        `json:"state"`
	SourceTableIDs []string     `json:"source_table_ids"`
	GroupIDs       []string     `json:"group_ids"`
	Message        string       `json:"message"`
	Range          shared.Range `json:"range"`
}
type Delivery struct {
	ID             string    `json:"id"`
	EventID        string    `json:"event_id"`
	RuleID         string    `json:"rule_id"`
	GroupIDs       []string  `json:"group_ids"`
	TableIDs       []string  `json:"table_ids"`
	ChannelID      string    `json:"channel_id"`
	Recipient      Recipient `json:"recipient"`
	Status         string    `json:"status"`
	Attempts       int       `json:"attempts"`
	NextAttempt    string    `json:"next_attempt"`
	CreatedAt      string    `json:"created_at"`
	UpdatedAt      string    `json:"updated_at"`
	SentAt         string    `json:"sent_at,omitempty"`
	Error          string    `json:"error"`
	ProviderID     string    `json:"provider_id"`
	Payload        Event     `json:"payload"`
	ResponseID     string    `json:"response_id,omitempty"`
	Stage          string    `json:"stage,omitempty"`
	UserID         string    `json:"user_id,omitempty"`
	UserIDs        []string  `json:"user_ids,omitempty"`
	Priority       string    `json:"priority,omitempty"`
	AckURL         string    `json:"ack_url,omitempty"`
	Generation     int       `json:"generation,omitempty"`
	DeliveryStatus string    `json:"delivery_status,omitempty"`
}
type Route struct {
	Target   Target   `json:"target"`
	GroupIDs []string `json:"group_ids"`
	UserID   string   `json:"user_id,omitempty"`
}
type Preview struct {
	States   []State              `json:"states"`
	Routes   []Route              `json:"routes"`
	Warnings []string             `json:"warnings"`
	Range    shared.Range         `json:"range"`
	Result   shared.QueryResponse `json:"result"`
}
type Module struct {
	deps   shared.Dependencies
	client *http.Client
	now    func() time.Time
	mu     sync.Mutex
}

func id() string { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }

// A fixed fractional width makes SQLite TEXT ordering identical to UTC time ordering.
func stamp(t time.Time) string        { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }
func parse(s string) time.Time        { t, _ := time.Parse(time.RFC3339Nano, s); return t }
func encode(v any) string             { b, _ := json.Marshal(v); return string(b) }
func recipientKey(p Recipient) string { p.Mentions = nil; return encode(p) }
