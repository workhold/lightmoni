package assistant

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

const connectionTestTimeout = 15 * time.Second

type connectionTestInput struct {
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
	UseSavedKey bool   `json:"use_saved_key"`
	Protocol    string `json:"protocol"`
	Model       string `json:"model"`
}

type connectionTestView struct {
	OK       bool   `json:"ok"`
	BaseURL  string `json:"base_url"`
	Protocol string `json:"protocol"`
	Model    string `json:"model"`
	Latency  int64  `json:"latency_ms"`
}

type connectionKeyError struct {
	status  int
	code    string
	message string
}

func (e *connectionKeyError) Error() string { return e.message }

func connectionError(w http.ResponseWriter, status int, code, message string) {
	shared.JSON(w, status, map[string]string{"error": message, "code": code})
}

// testConnection performs one explicit, minimal generation request through the
// configured Mastra runtime. It deliberately does not load or save a session,
// persist configuration, or return provider output.
func (s *Service) testConnection(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	if !p.Admin {
		connectionError(w, http.StatusForbidden, "forbidden", "administrator required")
		return
	}

	var input connectionTestInput
	if err := decode(r, &input, 16<<10); err != nil {
		connectionError(w, http.StatusBadRequest, "invalid_input", "invalid model connection input")
		return
	}

	base, err := canonicalAPIBase(input.BaseURL)
	if err != nil || !concreteProtocol(input.Protocol) {
		connectionError(w, http.StatusBadRequest, "invalid_input", "enter a valid API base URL and a concrete model protocol")
		return
	}
	model := strings.TrimSpace(input.Model)
	if model == "" || len(model) > 200 || containsControl(model) || len(input.APIKey) > 4096 || containsControl(input.APIKey) {
		connectionError(w, http.StatusBadRequest, "invalid_input", "enter a valid model and API key")
		return
	}

	key, err := s.connectionKey(r.Context(), base, input.APIKey, input.UseSavedKey)
	if err != nil {
		status, code := http.StatusBadRequest, "saved_key_mismatch"
		var keyErr *connectionKeyError
		if errors.As(err, &keyErr) {
			status, code = keyErr.status, keyErr.code
		}
		connectionError(w, status, code, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), connectionTestTimeout)
	defer cancel()
	started := time.Now()
	config := Config{
		BaseURL:         base,
		Protocol:        input.Protocol,
		Model:           model,
		APIKey:          key,
		Enabled:         true,
		MaxInputTokens:  4096,
		MaxOutputTokens: 256,
		MaxSteps:        1,
	}
	runtimeInput := RuntimeInput{
		System:   "Connection test. Reply with OK only.",
		Config:   config,
		Messages: []Message{{Role: "user", Content: "Reply with OK only."}},
		Tools:    []RuntimeTool{},
	}
	// All runtime frames, including generated text and usage, are intentionally
	// discarded. This request has no session and cannot mutate configuration.
	err = s.options.Runtime.Run(ctx, runtimeInput, nil, func(RuntimeFrame) error { return nil })
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			connectionError(w, http.StatusGatewayTimeout, "timeout", "model connection test timed out")
			return
		}
		connectionError(w, http.StatusBadGateway, "provider_unavailable", "model connection failed; check the endpoint, model and credentials")
		return
	}

	shared.JSON(w, http.StatusOK, connectionTestView{OK: true, BaseURL: base, Protocol: input.Protocol, Model: model, Latency: time.Since(started).Milliseconds()})
}

func (s *Service) connectionKey(ctx context.Context, base, explicit string, useSaved bool) (string, error) {
	if explicit != "" || !useSaved {
		return explicit, nil
	}
	cfg, err := s.loadConfig(ctx)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", &connectionKeyError{status: http.StatusBadRequest, code: "saved_key_mismatch", message: "saved credential is unavailable for this address; enter a new API key or clear the saved key"}
		}
		return "", &connectionKeyError{status: http.StatusInternalServerError, code: "configuration_unavailable", message: "cannot read assistant configuration"}
	}
	savedBase, savedErr := canonicalAPIBase(cfg.BaseURL)
	if cfg.APIKey == "" || savedErr != nil || savedBase != base {
		return "", &connectionKeyError{status: http.StatusBadRequest, code: "saved_key_mismatch", message: "saved credential is unavailable for this address; enter a new API key or clear the saved key"}
	}
	return cfg.APIKey, nil
}
