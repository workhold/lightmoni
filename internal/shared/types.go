package shared

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

type Range struct {
	From string `json:"from"`
	To   string `json:"to"`
}
type Parameter struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}
type Query struct {
	RefID  string               `json:"refId"`
	SQL    string               `json:"sql"`
	Params map[string]Parameter `json:"params,omitempty"`
}
type QueryRequest struct {
	RequestID  string  `json:"request_id"`
	Range      Range   `json:"range"`
	IntervalMS int64   `json:"interval_ms"`
	Queries    []Query `json:"queries"`
	Source     string  `json:"source,omitempty"`
}
type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable,omitempty"`
}
type Frame struct {
	Columns []Column `json:"columns"`
	Rows    [][]any  `json:"rows"`
}
type QueryResult struct {
	RefID     string  `json:"refId"`
	Status    string  `json:"status"`
	Frames    []Frame `json:"frames"`
	Complete  bool    `json:"complete"`
	Truncated bool    `json:"truncated"`
	ElapsedMS int64   `json:"elapsed_ms"`
	Error     string  `json:"error,omitempty"`
}
type QueryResponse struct {
	RequestID string        `json:"request_id"`
	Results   []QueryResult `json:"results"`
}
type Table struct {
	System                 bool     `json:"system"`
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	LogicalName            string   `json:"logical_name"`
	Kind                   string   `json:"kind"`
	MetricType             string   `json:"metric_type,omitempty"`
	Columns                []Column `json:"columns"`
	Services               []string `json:"services"`
	AlertGroupID           string   `json:"alert_group_id,omitempty"`
	RetentionDays          *int     `json:"retention_days"`
	EffectiveRetentionDays int      `json:"effective_retention_days"`
}
type Dependencies struct {
	DB               *sql.DB
	Query            func(context.Context, QueryRequest) (QueryResponse, error)
	Catalog          func(context.Context) ([]Table, error)
	ReferencedTables func(context.Context, string) ([]string, error)
	ExternalURL      string
	Encrypt          func(string) (string, error)
	Decrypt          func(string) (string, error)
}
type User struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Role      string `json:"role"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}
type userContextKey struct{}

func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userContextKey{}, u)
}
func CurrentUser(r *http.Request) User { u, _ := r.Context().Value(userContextKey{}).(User); return u }
func IsAdmin(r *http.Request) bool     { return CurrentUser(r).Role == "admin" }
func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}
func Decode(r *http.Request, v any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2<<20))
	decoder.UseNumber()
	if err := decoder.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON object")
	}
	return nil
}
