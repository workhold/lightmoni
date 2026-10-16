package assistant

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var toolName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

const (
	ProtocolOpenAIChat      = "openai-chat-completions"
	ProtocolOpenAIResponses = "openai-responses"
	ProtocolAnthropic       = "anthropic-messages"
	ProtocolGoogle          = "google-generative-ai"
)

func concreteProtocol(protocol string) bool {
	switch protocol {
	case ProtocolOpenAIChat, ProtocolOpenAIResponses, ProtocolAnthropic, ProtocolGoogle:
		return true
	default:
		return false
	}
}

func normalizedConfig(c Config) Config {
	if c.Protocol == "" {
		c.Protocol = ProtocolOpenAIChat
	}
	if c.MaxInputTokens == 0 {
		c.MaxInputTokens = 32000
	}
	if c.MaxOutputTokens == 0 {
		c.MaxOutputTokens = 4096
	}
	if c.MaxSteps == 0 {
		c.MaxSteps = 8
	}
	if c.ReasoningEffort == "" {
		c.ReasoningEffort = ReasoningProviderDefault
	}
	return c
}

func validReasoningEffort(value string) bool {
	switch value {
	case ReasoningProviderDefault, ReasoningNone, ReasoningMinimal, ReasoningLow, ReasoningMedium, ReasoningHigh, ReasoningXHigh:
		return true
	default:
		return false
	}
}
func ValidateConfig(c Config) error {
	c = normalizedConfig(c)
	if !concreteProtocol(c.Protocol) {
		return errors.New("select a concrete supported model protocol before saving")
	}
	if !validReasoningEffort(c.ReasoningEffort) {
		return errors.New("select a supported reasoning effort")
	}
	if c.MaxInputTokens < 4096 || c.MaxInputTokens > 128000 || c.MaxOutputTokens < 256 || c.MaxOutputTokens > 16384 || c.MaxSteps < 1 || c.MaxSteps > 12 {
		return errors.New("input limit must be 4096–128000, output limit 256–16384 and steps 1–12")
	}

	if _, err := canonicalAPIBase(c.BaseURL); err != nil {
		return errors.New("base_url must be an HTTP(S) API base URL without credentials, query or fragment")
	}
	if strings.TrimSpace(c.Model) == "" || len(c.Model) > 200 || containsControl(c.Model) || len(c.APIKey) > 4096 || containsControl(c.APIKey) {
		return errors.New("model is required and configuration exceeds its allowed size")
	}
	return nil
}

// canonicalAPIBase accepts the API base or one of the standard endpoint URLs.
// Escaped path bytes are preserved so tenant paths such as %2F remain distinct.
func canonicalAPIBase(raw string) (string, error) {
	if len(raw) > 2048 || containsControl(raw) || strings.Contains(raw, "#") {
		return "", errors.New("invalid API base URL")
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", errors.New("invalid API base URL")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return "", errors.New("invalid API base URL")
	}
	escaped := u.EscapedPath()
	for strings.HasSuffix(escaped, "/") {
		escaped = strings.TrimSuffix(escaped, "/")
	}
	if match := googleGenerationPath.FindStringIndex(escaped); match != nil {
		escaped = escaped[:match[0]]
	} else {
		for _, suffix := range []string{"/chat/completions", "/responses", "/messages", "/models"} {
			if strings.HasSuffix(escaped, suffix) {
				escaped = strings.TrimSuffix(escaped, suffix)
				break
			}
		}
	}
	for strings.HasSuffix(escaped, "/") {
		escaped = strings.TrimSuffix(escaped, "/")
	}
	if escaped == "/" {
		escaped = ""
	}
	decoded, err := url.PathUnescape(escaped)
	if err != nil {
		return "", errors.New("invalid API base URL")
	}
	host := strings.ToLower(u.Hostname())
	if zone := strings.IndexByte(u.Hostname(), '%'); zone >= 0 {
		host = strings.ToLower(u.Hostname()[:zone]) + u.Hostname()[zone:]
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port := u.Port(); port != "" {
		numeric, err := strconv.Atoi(port)
		if err != nil || numeric < 1 || numeric > 65535 {
			return "", errors.New("invalid API base URL")
		}
		if !((u.Scheme == "http" && numeric == 80) || (u.Scheme == "https" && numeric == 443)) {
			host += ":" + strconv.Itoa(numeric)
		}
	}
	u.Host = host
	u.Path = decoded
	u.RawPath = ""
	if escaped != "" && escaped != decoded {
		u.RawPath = escaped
	}
	u.RawQuery, u.Fragment, u.ForceQuery = "", "", false
	return strings.TrimSuffix(u.String(), "/"), nil
}

func appendAPIPath(base, suffix string) string {
	return strings.TrimRight(base, "/") + "/" + suffix
}

func containsControl(value string) bool {
	return strings.ContainsFunc(value, unicode.IsControl)
}

var googleGenerationPath = regexp.MustCompile(`/models/[^/]+:(?:generateContent|streamGenerateContent)$`)

// protocolURLHint is a recommendation from the user-supplied URL, never proof
// that a model supports generation or tool calls. Explicit selection overrides it.
func protocolURLHint(raw string) (string, string) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", ""
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	switch {
	case strings.HasSuffix(path, "/chat/completions"):
		return ProtocolOpenAIChat, "endpoint-path"
	case strings.HasSuffix(path, "/responses"):
		return ProtocolOpenAIResponses, "endpoint-path"
	case strings.HasSuffix(path, "/messages"):
		return ProtocolAnthropic, "endpoint-path"
	case googleGenerationPath.MatchString(path):
		return ProtocolGoogle, "endpoint-path"
	}
	switch strings.ToLower(u.Hostname()) {
	case "api.openai.com":
		return ProtocolOpenAIResponses, "official-host"
	case "api.anthropic.com":
		return ProtocolAnthropic, "official-host"
	case "generativelanguage.googleapis.com":
		return ProtocolGoogle, "official-host"
	}
	return "", ""
}
