package assistant

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type RuntimeTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}
type RuntimeInput struct {
	System         string          `json:"system"`
	Config         Config          `json:"config"`
	Messages       []Message       `json:"messages"`
	Summary        string          `json:"summary,omitempty"`
	SummaryThrough int             `json:"summary_through,omitempty"`
	Context        json.RawMessage `json:"context,omitempty"`
	Tools          []RuntimeTool   `json:"tools"`
}
type RuntimeFrame struct {
	Type     string          `json:"type"`
	Name     string          `json:"name,omitempty"`
	ID       string          `json:"id,omitempty"`
	Input    json.RawMessage `json:"input,omitempty"`
	Data     map[string]any  `json:"data,omitempty"`
	Messages []Message       `json:"messages,omitempty"`
	Summary  string          `json:"summary,omitempty"`
	Through  int             `json:"through,omitempty"`
	Code     string          `json:"code,omitempty"`
}
type TurnRuntime interface {
	Run(context.Context, RuntimeInput, func(context.Context, string, json.RawMessage) (any, error), func(RuntimeFrame) error) error
}

// MastraRuntime has no public listener. Credentials go through private stdin,
// never command arguments/environment; each turn owns and terminates its worker.
type MastraRuntime struct{ Node, Entry string }

func (m *MastraRuntime) Run(ctx context.Context, input RuntimeInput, tool func(context.Context, string, json.RawMessage) (any, error), event func(RuntimeFrame) error) error {
	node := m.Node
	if node == "" {
		node = "node"
	}
	entry := m.Entry
	if entry == "" {
		entry = filepath.Join("ai-runtime", "dist", "runner.js")
	}
	if _, err := os.Stat(entry); err != nil {
		return errors.New("Mastra runtime is not built; run npm --prefix ai-runtime ci and npm --prefix ai-runtime run build")
	}
	cmd := exec.CommandContext(ctx, node, entry)
	// Provider credentials and private runtime errors never become service logs.
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return errors.New("cannot create Mastra input pipe")
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return errors.New("cannot create Mastra output pipe")
	}
	if err = cmd.Start(); err != nil {
		return errors.New("cannot start Mastra runtime; install Node.js >=22.13 or configure LIGHTMONI_AI_NODE")
	}
	defer func() { _ = stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	encoder := json.NewEncoder(stdin)
	if err = encoder.Encode(map[string]any{"type": "start", "input": input}); err != nil {
		return errors.New("cannot initialize Mastra runtime")
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	terminal := false
	seen := map[string]bool{}
	for scanner.Scan() {
		if err = ctx.Err(); err != nil {
			return err
		}
		var frame RuntimeFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			return errors.New("invalid Mastra runtime response")
		}
		switch frame.Type {
		case "tool.request":
			if frame.ID == "" || len(frame.ID) > 256 || seen[frame.ID] || !toolName.MatchString(frame.Name) || tool == nil {
				return errors.New("invalid Mastra tool request")
			}
			seen[frame.ID] = true
			value, toolErr := tool(ctx, frame.Name, frame.Input)
			if toolErr != nil {
				value = map[string]string{"error": toolErr.Error()}
			}
			encoded, encodeErr := json.Marshal(value)
			if encodeErr != nil || len(encoded) > 128<<10 {
				value = map[string]string{"error": "tool result is too large or cannot be encoded; narrow the query"}
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			if err = encoder.Encode(map[string]any{"type": "tool.response", "id": frame.ID, "value": value}); err != nil {
				return errors.New("Mastra runtime stopped during tool execution")
			}
		case "event":
			switch frame.Name {
			case "assistant.delta", "assistant.message", "step.started", "step.completed", "tool.call", "tool.result", "turn.usage", "context.compacting", "context.compacted":
			default:
				return errors.New("invalid Mastra event")
			}
			if err = event(frame); err != nil {
				return err
			}
		case "checkpoint", "compacted":
			if err = event(frame); err != nil {
				return err
			}
		case "done":
			terminal = true
		case "error":
			return runtimeError(frame.Code)
		default:
			return errors.New("invalid Mastra runtime frame")
		}
		if terminal {
			break
		}
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if scanner.Err() != nil || !terminal {
		return errors.New("Mastra runtime interrupted; retry this turn")
	}
	return nil
}
func runtimeError(code string) error {
	switch code {
	case "context_limit":
		return errors.New("conversation input exceeds its budget; reduce selected context or increase the input limit")
	case "summary_failed":
		return errors.New("history summarization failed; source history is preserved, retry or start a new session")
	case "step_limit":
		return errors.New("assistant reached its tool step limit; narrow the request or increase the step limit")
	case "output_limit":
		return errors.New("model reached its output limit; narrow the request or increase the output limit")
	case "invalid_history", "invalid_checkpoint":
		return errors.New("assistant history is inconsistent; start a new session")
	case "invalid_provider_state":
		return errors.New("model continuation state is invalid or exceeds its size limit; start a new session or use another model")
	default:
		return errors.New("model provider request failed; check endpoint, model and credentials or retry")
	}
}

func (s *Service) runMastra(ctx context.Context, p Principal, cfg Config, session *Session, currentContext json.RawMessage, emit func(string, map[string]any) error) error {
	cfg = normalizedConfig(cfg)
	tools := make([]RuntimeTool, 0, len(s.options.Tools))
	for _, t := range s.options.Tools {
		tools = append(tools, RuntimeTool{Name: t.Name, Description: t.Description, Schema: t.InputSchema})
	}
	base := append([]Message(nil), session.Messages...)
	if err := validateProviderMetadata(base); err != nil {
		return err
	}
	checkpointLength := 0
	input := RuntimeInput{System: s.options.System, Config: cfg, Messages: base, Summary: session.Summary, SummaryThrough: session.SummaryThrough, Context: currentContext, Tools: tools}
	return s.options.Runtime.Run(ctx, input, func(toolCtx context.Context, name string, args json.RawMessage) (any, error) {
		for _, t := range s.options.Tools {
			if t.Name == name {
				return t.Execute(toolCtx, p, args)
			}
		}
		return nil, errors.New("this tool is not registered")
	}, func(frame RuntimeFrame) error {
		switch frame.Type {
		case "compacted":
			if protectedCredential(frame.Summary, cfg.APIKey) {
				return errors.New("model response contained protected credentials")
			}
			if frame.Through <= session.SummaryThrough || frame.Through >= len(base) || base[frame.Through].Role != "user" || strings.TrimSpace(frame.Summary) == "" || len(frame.Summary) > 8192 {
				return errors.New("invalid assistant summary checkpoint")
			}
			session.Summary = frame.Summary
			session.SummaryThrough = frame.Through
			return nil // The immediately following context.compacted event commits it.
		case "checkpoint":
			if publicCheckpointContainsCredential(frame.Messages, cfg.APIKey) {
				return errors.New("model response contained protected credentials")
			}
			if len(frame.Messages) < checkpointLength {
				return errors.New("assistant checkpoint regressed")
			}
			if err := validateProviderMetadata(frame.Messages); err != nil {
				return err
			}
			for _, m := range frame.Messages {
				if m.Role != "assistant" && m.Role != "tool" {
					return errors.New("invalid assistant checkpoint role")
				}
				if len(m.Content) > 128<<10 {
					return errors.New("assistant checkpoint exceeds size limit")
				}
				for _, call := range m.ToolCalls {
					if call.ID == "" || !toolName.MatchString(call.Function.Name) || !json.Valid([]byte(call.Function.Arguments)) {
						return errors.New("invalid assistant checkpoint call")
					}
				}
			}
			if len(pendingTools(frame.Messages)) > 0 {
				return errors.New("incomplete assistant tool checkpoint")
			}
			messages := append(append([]Message(nil), base...), frame.Messages...)
			if err := validateProviderMetadata(messages); err != nil {
				return err
			}
			session.Messages = messages
			checkpointLength = len(frame.Messages)
			persistCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
			defer done()
			return s.saveSession(persistCtx, p, session)
		case "event":
			// Do not let a provider echo its key into public event text or tool errors.
			if protectedCredential(frame.Data, cfg.APIKey) {
				return errors.New("model response contained protected credentials")
			}
			return emit(frame.Name, frame.Data)
		}
		return fmt.Errorf("unexpected assistant runtime event")
	})
}

// Scan decoded public strings and their JSON-escaped spelling. Provider state
// stays outside this check: opaque ciphertext/signatures are never public.
func protectedCredential(value any, secret string) bool {
	if secret == "" {
		return false
	}
	encoded, _ := json.Marshal(secret)
	spelling := string(encoded[1 : len(encoded)-1])
	var scan func(any) bool
	scan = func(value any) bool {
		switch v := value.(type) {
		case string:
			return strings.Contains(v, secret) || strings.Contains(v, spelling)
		case map[string]any:
			for key, item := range v {
				if scan(key) || scan(item) {
					return true
				}
			}
		case []any:
			for _, item := range v {
				if scan(item) {
					return true
				}
			}
		}
		return false
	}
	return scan(value)
}

func publicCheckpointContainsCredential(messages []Message, secret string) bool {
	if secret == "" {
		return false
	}
	public := publicSession(Session{Messages: messages})
	encoded, _ := json.Marshal(public.Messages)
	var value any
	_ = json.Unmarshal(encoded, &value)
	if protectedCredential(value, secret) {
		return true
	}
	// Function arguments are themselves JSON strings; parse them once so escape
	// choices cannot conceal credentials that would become public tool inputs.
	for _, message := range messages {
		for _, call := range message.ToolCalls {
			var arguments any
			if json.Unmarshal([]byte(call.Function.Arguments), &arguments) == nil && protectedCredential(arguments, secret) {
				return true
			}
		}
	}
	return false
}

const maxProviderStateString = 256 << 10
const maxCheckpointProviderState = 1 << 20

func validateProviderMetadata(messages []Message) error {
	total := 0
	for _, message := range messages {
		for _, call := range message.ToolCalls {
			if err := validateProviderOptions(call.ProviderOptions); err != nil {
				return err
			}
			if len(call.ProviderOptions) > 0 {
				encoded, _ := json.Marshal(call.ProviderOptions)
				total += len(encoded)
			}
		}
		for _, state := range message.ProviderState {
			if message.Role != "assistant" || (state.Type != "text" && state.Type != "reasoning") {
				return errors.New("invalid assistant provider state")
			}
			if state.Type == "reasoning" && state.Text != "" {
				return errors.New("reasoning plaintext is not allowed in assistant provider state")
			}
			if len(state.Text) > 128<<10 || (state.Type == "text" && !strings.Contains(message.Content, state.Text)) {
				return errors.New("assistant signed text must match public message content")
			}
			if err := validateProviderOptions(state.ProviderOptions); err != nil {
				return err
			}
		}
		if len(message.ProviderState) > 0 {
			encoded, _ := json.Marshal(message.ProviderState)
			total += len(encoded)
		}
		if total > maxCheckpointProviderState {
			return errors.New("assistant provider state exceeds its size limit")
		}
	}
	return nil
}

func validateProviderOptions(options ProviderOptions) error {
	for provider, fields := range options {
		for field, value := range fields {
			allowed := (provider == "google" && field == "thoughtSignature") || (provider == "openai" && (field == "itemId" || field == "reasoningEncryptedContent"))
			if !allowed || len(value) > maxProviderStateString {
				return errors.New("invalid or oversized assistant provider options")
			}
		}
		if provider != "google" && provider != "openai" {
			return errors.New("invalid assistant provider options")
		}
	}
	return nil
}
