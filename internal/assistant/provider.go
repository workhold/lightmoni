package assistant

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

var toolName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func ValidateConfig(c Config) error {
	u, err := url.Parse(c.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("base_url must be an HTTP(S) API base URL without credentials, query or fragment")
	}
	if strings.TrimSpace(c.Model) == "" || len(c.Model) > 200 || len(c.APIKey) > 4096 {
		return errors.New("model is required and configuration exceeds its allowed size")
	}
	return nil
}

type completion struct {
	Content string
	Calls   []ToolCall
}

// streamCompletion understands fragmented OpenAI-compatible tool call deltas.
// It never retries model calls: a transport failure has an explicit failed turn.
func streamCompletion(ctx context.Context, client *http.Client, cfg Config, messages []Message, tools []Tool, token func(string) error) (completion, error) {
	definitions := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		var schema any
		if err := json.Unmarshal(tool.InputSchema, &schema); err != nil {
			return completion{}, fmt.Errorf("invalid schema for tool %s", tool.Name)
		}
		definitions = append(definitions, map[string]any{"type": "function", "function": map[string]any{"name": tool.Name, "description": tool.Description, "parameters": schema}})
	}
	payload := map[string]any{"model": cfg.Model, "messages": messages, "stream": true, "max_tokens": 4096}
	if len(definitions) > 0 {
		payload["tools"] = definitions
		payload["tool_choice"] = "auto"
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return completion{}, err
	}
	if len(body) > 256*1024 {
		return completion{}, errors.New("conversation context is too large; start a new session")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return completion{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return completion{}, ctx.Err()
		}
		return completion{}, errors.New("model provider connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Do not return provider bodies: they can echo keys, prompts or proxy secrets.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return completion{}, fmt.Errorf("model provider returned HTTP %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return completion{}, errors.New("model provider did not return an SSE stream")
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 4096), 256*1024)
	var result completion
	calls := map[int]*ToolCall{}
	var eventData []string
	finished := false
	consume := func() error {
		if len(eventData) == 0 {
			return nil
		}
		data := strings.Join(eventData, "\n")
		eventData = nil
		if data == "[DONE]" {
			finished = true
			return nil
		}
		var chunk struct {
			Error   *json.RawMessage `json:"error"`
			Choices []struct {
				Finish *string `json:"finish_reason"`
				Delta  struct {
					Content string `json:"content"`
					Calls   []struct {
						Index    int          `json:"index"`
						ID       string       `json:"id"`
						Function FunctionCall `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return errors.New("model provider returned malformed stream data")
		}
		if chunk.Error != nil {
			return errors.New("model provider reported a stream error")
		}
		if len(chunk.Choices) == 0 {
			return nil
		}
		choice := chunk.Choices[0]
		if choice.Delta.Content != "" {
			result.Content += choice.Delta.Content
			if len(result.Content) > 128*1024 {
				return errors.New("model response exceeded size limit")
			}
			if err := token(choice.Delta.Content); err != nil {
				return err
			}
		}
		for _, delta := range choice.Delta.Calls {
			if delta.Index < 0 || delta.Index > 15 {
				return errors.New("model returned too many tool calls")
			}
			call := calls[delta.Index]
			if call == nil {
				call = &ToolCall{Type: "function"}
				calls[delta.Index] = call
			}
			call.ID += delta.ID
			call.Function.Name += delta.Function.Name
			call.Function.Arguments += delta.Function.Arguments
			if len(call.Function.Arguments) > 64*1024 {
				return errors.New("tool arguments exceeded size limit")
			}
		}
		if choice.Finish != nil {
			if *choice.Finish == "length" {
				return errors.New("model response reached its output limit; shorten the request")
			}
			if *choice.Finish == "content_filter" {
				return errors.New("model provider declined the response")
			}
			if *choice.Finish == "stop" || *choice.Finish == "tool_calls" {
				finished = true
			}
		}
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := consume(); err != nil {
				return result, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			eventData = append(eventData, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		return result, errors.New("model provider stream interrupted")
	}
	if err := consume(); err != nil {
		return result, err
	}
	if !finished {
		return result, errors.New("model provider stream ended before completion")
	}
	indexes := make([]int, 0, len(calls))
	for i := range calls {
		indexes = append(indexes, i)
	}
	sort.Ints(indexes)
	for _, i := range indexes {
		call := *calls[i]
		if call.ID == "" || !toolName.MatchString(call.Function.Name) || !json.Valid([]byte(call.Function.Arguments)) {
			return result, errors.New("model returned an invalid tool call")
		}
		result.Calls = append(result.Calls, call)
	}
	if len(result.Calls) == 0 && strings.TrimSpace(result.Content) == "" {
		return result, errors.New("model returned an empty response")
	}
	return result, nil
}
