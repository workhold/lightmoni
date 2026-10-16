package assistant

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type runningTurn struct {
	cancel context.CancelFunc
	turnID string
}

type Service struct {
	options Options
	mu      sync.Mutex
	active  map[string]runningTurn
	encrypt func(string) (string, error)
	decrypt func(string) (string, error)
}

// New adapts the Doca-style assistant host to the common LightMoni services.
func New(deps shared.Dependencies) (*Service, error) {
	store, err := NewSQLiteStore(deps.DB)
	if err != nil {
		return nil, err
	}
	if deps.Encrypt == nil || deps.Decrypt == nil {
		return nil, errors.New("assistant requires host encryption functions")
	}
	s, err := NewWithOptions(Options{Runtime: &MastraRuntime{Node: os.Getenv("LIGHTMONI_AI_NODE"), Entry: os.Getenv("LIGHTMONI_AI_RUNNER")}, Store: store, Actor: func(r *http.Request) (Principal, error) {
		u := shared.CurrentUser(r)
		if u.ID == "" {
			return Principal{}, errors.New("login required")
		}
		return Principal{ID: u.ID, Admin: u.Role == "admin"}, nil
	}, Tools: monitoringTools(deps)})
	if err != nil {
		return nil, err
	}
	s.encrypt = deps.Encrypt
	s.decrypt = deps.Decrypt
	return s, nil
}

func NewWithOptions(options Options) (*Service, error) {
	if options.Store == nil || options.Actor == nil {
		return nil, errors.New("assistant requires Store and authenticated Actor")
	}
	if options.MaxConcurrentTurns == 0 {
		options.MaxConcurrentTurns = 4
	}
	if options.MaxConcurrentTurns < 1 || options.MaxConcurrentTurns > 32 {
		return nil, errors.New("assistant concurrency limit must be between 1 and 32")
	}
	if options.Runtime == nil {
		options.Runtime = &MastraRuntime{Node: os.Getenv("LIGHTMONI_AI_NODE"), Entry: os.Getenv("LIGHTMONI_AI_RUNNER")}
	}
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("provider redirects are not allowed")
		}}
	}
	if options.TurnTimeout <= 0 {
		options.TurnTimeout = 2 * time.Minute
	}
	if options.MaxSteps <= 0 || options.MaxSteps > 12 {
		options.MaxSteps = 8
	}
	if options.System == "" {
		options.System = systemPrompt
	}
	seen := map[string]bool{}
	for _, tool := range options.Tools {
		if !toolName.MatchString(tool.Name) || seen[tool.Name] || tool.Execute == nil || !json.Valid(tool.InputSchema) || (tool.Effect != "read" && tool.Effect != "draft") {
			return nil, fmt.Errorf("invalid assistant tool %q", tool.Name)
		}
		seen[tool.Name] = true
	}
	return &Service{options: options, active: map[string]runningTurn{}, encrypt: func(s string) (string, error) { return s, nil }, decrypt: func(s string) (string, error) { return s, nil }}, nil
}

func (s *Service) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/assistant/config", s.config)
	mux.HandleFunc("PUT /api/v1/assistant/config", s.config)
	mux.HandleFunc("POST /api/v1/assistant/models", s.models)
	mux.HandleFunc("POST /api/v1/assistant/test-connection", s.testConnection)
	mux.HandleFunc("GET /api/v1/assistant/sessions", s.sessions)
	mux.HandleFunc("POST /api/v1/assistant/sessions", s.sessions)
	mux.HandleFunc("GET /api/v1/assistant/sessions/{id}", s.session)
	mux.HandleFunc("POST /api/v1/assistant/sessions/{id}/turns", s.turn)
	mux.HandleFunc("POST /api/v1/assistant/sessions/{id}/cancel", s.cancel)
}

func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func now() string                              { return time.Now().UTC().Format(time.RFC3339Nano) }
func sessionKey(p Principal, id string) string { return "session/" + p.ID + "/" + id }
func (s *Service) actor(w http.ResponseWriter, r *http.Request) (Principal, bool) {
	p, err := s.options.Actor(r)
	if err != nil || p.ID == "" {
		shared.Error(w, 401, "login required")
		return p, false
	}
	return p, true
}

func (s *Service) loadConfig(ctx context.Context) (Config, error) {
	b, err := s.options.Store.Get(ctx, "config")
	if errors.Is(err, ErrNotFound) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err = json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.APIKey != "" {
		c.APIKey, err = s.decrypt(c.APIKey)
	}
	return c, err
}
func (s *Service) config(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	c, err := s.loadConfig(r.Context())
	if err != nil {
		shared.Error(w, 500, "cannot read assistant configuration")
		return
	}
	if r.Method == http.MethodPut {
		if !p.Admin {
			shared.Error(w, 403, "administrator required")
			return
		}
		var update struct {
			Config
			ClearKey bool `json:"clear_key"`
		}
		if err := decode(r, &update, 16<<10); err != nil {
			shared.Error(w, 400, "invalid assistant configuration")
			return
		}
		incoming := normalizedConfig(update.Config)
		canonicalIncoming, canonicalErr := canonicalAPIBase(incoming.BaseURL)
		if canonicalErr != nil {
			shared.Error(w, 400, "base_url must be an HTTP(S) API base URL without credentials, query or fragment")
			return
		}
		incoming.BaseURL = canonicalIncoming
		// Empty key preserves the existing secret. clear_key explicitly removes it.
		if incoming.APIKey == "" && !update.ClearKey {
			if c.APIKey != "" {
				oldBase, oldErr := canonicalAPIBase(c.BaseURL)
				if oldErr != nil || oldBase != incoming.BaseURL {
					shared.Error(w, 400, "a new API key or clear_key is required when changing the API base URL")
					return
				}
			}
			incoming.APIKey = c.APIKey
		}
		if err := ValidateConfig(incoming); err != nil {
			shared.Error(w, 400, err.Error())
			return
		}
		stored := incoming
		if stored.APIKey != "" {
			stored.APIKey, err = s.encrypt(stored.APIKey)
			if err != nil {
				shared.Error(w, 500, "cannot protect assistant credential")
				return
			}
		}
		b, _ := json.Marshal(stored)
		if err = s.options.Store.Put(r.Context(), "config", b); err != nil {
			shared.Error(w, 500, "cannot save assistant configuration")
			return
		}
		c = incoming
	}
	c = normalizedConfig(c)
	baseURL := c.BaseURL
	if base, err := canonicalAPIBase(c.BaseURL); err == nil {
		baseURL = base
	}
	shared.JSON(w, 200, ConfigView{Runtime: "mastra", Protocol: c.Protocol, MaxInputTokens: c.MaxInputTokens, MaxOutputTokens: c.MaxOutputTokens, MaxSteps: c.MaxSteps, BaseURL: baseURL, Model: c.Model, HasKey: c.APIKey != "", Enabled: c.Enabled})
}

func decode(r *http.Request, value any, limit int64) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	var extra any
	if errors.Is(decoder.Decode(&extra), io.EOF) {
		return nil
	}
	return errors.New("multiple JSON values")
}

func (s *Service) sessions(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodPost {
		var input struct {
			Title string `json:"title"`
		}
		if err := decode(r, &input, 4096); err != nil {
			shared.Error(w, 400, "invalid session title")
			return
		}
		input.Title = strings.TrimSpace(input.Title)
		if len(input.Title) > 240 {
			shared.Error(w, 400, "session title is too long")
			return
		}
		if input.Title == "" {
			input.Title = "新对话"
		}
		session := Session{ID: randomID(), UserID: p.ID, Title: input.Title, CreatedAt: now(), UpdatedAt: now(), Messages: []Message{}, Events: []Event{}}
		if err := s.saveSession(r.Context(), p, &session); err != nil {
			shared.Error(w, 500, "cannot save assistant session")
			return
		}
		shared.JSON(w, 201, session)
		return
	}
	records, err := s.options.Store.List(r.Context(), "session/"+p.ID+"/")
	if err != nil {
		shared.Error(w, 500, "cannot list assistant sessions")
		return
	}
	items := []Session{}
	for _, b := range records {
		var session Session
		if json.Unmarshal(b, &session) == nil {
			session.Messages = nil
			session.Events = nil
			items = append(items, session)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
	shared.JSON(w, 200, map[string]any{"items": items})
}

func (s *Service) getSession(ctx context.Context, p Principal, id string) (Session, error) {
	var session Session
	b, err := s.options.Store.Get(ctx, sessionKey(p, id))
	if err != nil {
		return session, err
	}
	err = json.Unmarshal(b, &session)
	if err == nil && session.UserID != p.ID {
		return session, ErrNotFound
	}
	return session, err
}
func (s *Service) saveSession(ctx context.Context, p Principal, session *Session) error {
	session.UpdatedAt = now()
	b, err := json.Marshal(session)
	if err != nil {
		return err
	}
	if len(b) > 2<<20 {
		return errors.New("conversation storage limit reached; start a new session")
	}
	return s.options.Store.Put(ctx, sessionKey(p, session.ID), b)
}
func (s *Service) session(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	session, err := s.getSession(r.Context(), p, r.PathValue("id"))
	if err != nil {
		shared.Error(w, 404, "assistant session not found")
		return
	}
	shared.JSON(w, 200, publicSession(session))
}

func publicSession(session Session) Session {
	session.Messages = append([]Message(nil), session.Messages...)
	for i := range session.Messages {
		session.Messages[i].ProviderState = nil
		session.Messages[i].ToolCalls = append([]ToolCall(nil), session.Messages[i].ToolCalls...)
		for j := range session.Messages[i].ToolCalls {
			session.Messages[i].ToolCalls[j].ProviderOptions = nil
		}
	}
	return session
}

func (s *Service) cancel(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	key := sessionKey(p, r.PathValue("id"))
	s.mu.Lock()
	active, found := s.active[key]
	s.mu.Unlock()
	if found {
		active.cancel()
	}
	shared.JSON(w, 200, map[string]any{"cancelled": found})
}

func (s *Service) turn(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	var input TurnRequest
	if err := decode(r, &input, 48<<10); err != nil {
		shared.Error(w, 400, "invalid assistant message")
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.Text == "" || len(input.Text) > 16000 || len(input.Context) > 32000 {
		shared.Error(w, 400, "message is empty or exceeds the size limit")
		return
	}
	session, err := s.getSession(r.Context(), p, r.PathValue("id"))
	if err != nil {
		shared.Error(w, 404, "assistant session not found")
		return
	}
	cfg, err := s.loadConfig(r.Context())
	if err != nil {
		shared.Error(w, 500, "cannot read assistant configuration")
		return
	}
	if !cfg.Enabled || cfg.BaseURL == "" || cfg.Model == "" {
		shared.Error(w, 503, "AI provider is not configured or is disabled")
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		shared.Error(w, 500, "streaming response is unavailable")
		return
	}
	ctx, stop := context.WithTimeout(r.Context(), s.options.TurnTimeout)
	defer stop()
	key := sessionKey(p, session.ID)
	turnID := randomID()
	s.mu.Lock()
	if _, exists := s.active[key]; exists {
		s.mu.Unlock()
		shared.Error(w, 409, "this conversation already has an active turn")
		return
	}
	if len(s.active) >= s.options.MaxConcurrentTurns {
		s.mu.Unlock()
		shared.Error(w, 429, "assistant is busy; retry after another turn completes")
		return
	}
	s.active[key] = runningTurn{cancel: stop, turnID: turnID}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, key); s.mu.Unlock() }()
	// Reload after acquiring the turn slot so a delayed request cannot overwrite
	// progress committed by the immediately preceding turn.
	session, err = s.getSession(r.Context(), p, session.ID)
	if err != nil {
		shared.Error(w, 500, "cannot reload assistant session")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	_, _ = fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	sequence := int64(0)
	if n := len(session.Events); n > 0 {
		sequence = session.Events[n-1].Sequence + 1
	}
	lastPersist := time.Now()
	emit := func(kind string, data map[string]any) error {
		event := Event{Sequence: sequence, SessionID: session.ID, TurnID: turnID, Type: kind, Timestamp: now(), Data: data}
		sequence++
		// Coalesce adjacent text deltas only in durable history. Live SSE keeps
		// original chunks; replay keeps the same text with fewer stored events.
		storedEvent := event
		if kind == "assistant.delta" && len(session.Events) > 0 {
			last := session.Events[len(session.Events)-1]
			if last.Type == kind && last.TurnID == turnID && last.Data["step"] == data["step"] {
				storedEvent.Data = map[string]any{"step": data["step"], "text": fmt.Sprint(last.Data["text"]) + fmt.Sprint(data["text"])}
				session.Events = session.Events[:len(session.Events)-1]
			}
		}
		session.Events = append(session.Events, storedEvent)
		if len(session.Events) > 4096 {
			session.Events = session.Events[len(session.Events)-4096:]
		}
		persistCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		if kind != "assistant.delta" || time.Since(lastPersist) >= 250*time.Millisecond {
			if err := s.saveSession(persistCtx, p, &session); err != nil {
				return errors.New("cannot persist assistant progress")
			}
			lastPersist = time.Now()
		}
		b, _ := json.Marshal(event)
		if _, err := fmt.Fprintf(w, "id: %d\nevent: session-event\ndata: %s\n\n", event.Sequence, b); err != nil {
			return err
		}
		flusher.Flush()
		return nil
	}
	session.Messages = append(session.Messages, Message{Role: "user", Content: input.Text})
	if err = emit("user.message", map[string]any{"text": input.Text}); err == nil {
		err = emit("turn.started", map[string]any{})
	}
	if err == nil {
		err = s.run(ctx, p, cfg, &session, input.Context, emit)
	}
	if err != nil {
		kind := "turn.failed"
		message := err.Error()
		if ctx.Err() != nil {
			kind = "turn.cancelled"
			message = "request cancelled"
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				message = "assistant turn reached its time limit"
			}
		}
		// A cancelled tool call still needs a tool response in provider history.
		// Otherwise the next turn would send an invalid unresolved tool-call list.
		for _, call := range pendingTools(session.Messages) {
			toolMessage, _ := json.Marshal(map[string]string{"error": message})
			session.Messages = append(session.Messages, Message{Role: "tool", Content: string(toolMessage), ToolCallID: call.ID})
			_ = emit("tool.result", map[string]any{"call_id": call.ID, "tool": call.Function.Name, "status": "error", "value": map[string]string{"error": message}})
		}
		_ = emit(kind, map[string]any{"error": message})
		return
	}
	_ = emit("turn.completed", map[string]any{})
}

func (s *Service) run(ctx context.Context, p Principal, cfg Config, session *Session, currentContext json.RawMessage, emit func(string, map[string]any) error) error {
	return s.runMastra(ctx, p, cfg, session, currentContext, emit)
}

func pendingTools(messages []Message) []ToolCall {
	completed := map[string]bool{}
	for _, message := range messages {
		if message.Role == "tool" {
			completed[message.ToolCallID] = true
		}
	}
	var pending []ToolCall
	for _, message := range messages {
		for _, call := range message.ToolCalls {
			if !completed[call.ID] {
				pending = append(pending, call)
			}
		}
	}
	return pending
}
