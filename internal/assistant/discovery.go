package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

const (
	maxDiscoveryBody    = 1 << 20
	maxDiscoveryModels  = 500
	maxDiscoveryIDBytes = 200
	maxDiscoveryGETs    = 6
)

type discoveryInput struct {
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
	UseSavedKey bool   `json:"use_saved_key"`
	Protocol    string `json:"protocol"`
}

type discoveryModel struct {
	ID string `json:"id"`
}

type discoveryView struct {
	BaseURL              string           `json:"base_url"`
	Protocol             string           `json:"protocol"`
	ProtocolOptions      []string         `json:"protocol_options"`
	ProtocolSource       string           `json:"protocol_source"`
	RequiresConfirmation bool             `json:"requires_confirmation"`
	CapabilitiesVerified bool             `json:"capabilities_verified"`
	Models               []discoveryModel `json:"models"`
	Truncated            bool             `json:"truncated"`
}

func discoveryError(w http.ResponseWriter, status int, code, message string) {
	shared.JSON(w, status, map[string]string{"error": message, "code": code})
}

func (s *Service) models(w http.ResponseWriter, r *http.Request) {
	p, ok := s.actor(w, r)
	if !ok {
		return
	}
	if !p.Admin {
		discoveryError(w, 403, "forbidden", "administrator required")
		return
	}
	var input discoveryInput
	if err := decode(r, &input, 16<<10); err != nil {
		discoveryError(w, 400, "invalid_input", "invalid model discovery input")
		return
	}
	if input.Protocol == "" {
		input.Protocol = "auto"
	}
	if input.Protocol != "auto" && !concreteProtocol(input.Protocol) {
		discoveryError(w, 400, "invalid_protocol", "select a supported model protocol")
		return
	}
	base, err := canonicalAPIBase(input.BaseURL)
	if err != nil || len(input.APIKey) > 4096 || containsControl(input.APIKey) {
		discoveryError(w, 400, "invalid_input", "invalid model discovery input")
		return
	}
	key, usedSavedKey := input.APIKey, false
	if key == "" && input.UseSavedKey {
		cfg, err := s.loadConfig(r.Context())
		if err != nil {
			discoveryError(w, 500, "configuration_unavailable", "cannot read assistant configuration")
			return
		}
		savedBase, savedErr := canonicalAPIBase(cfg.BaseURL)
		if cfg.APIKey == "" || savedErr != nil || savedBase != base {
			discoveryError(w, 400, "saved_key_mismatch", "saved credential is unavailable for this address; enter a new API key or clear the saved key")
			return
		}
		key, usedSavedKey = cfg.APIKey, true
	}
	protocol, source := input.Protocol, "manual"
	profiles := []string{protocol}
	if protocol == "auto" {
		protocol, source = protocolURLHint(input.BaseURL)
		if protocol != "" {
			profiles = []string{protocol}
		} else {
			profiles = []string{ProtocolOpenAIChat, ProtocolAnthropic, ProtocolGoogle}
		}
	}
	models, actualBase, outcome := s.fetchModels(r.Context(), base, key, usedSavedKey, profiles)
	if !outcome.success {
		discoveryError(w, outcome.status, outcome.code, outcome.message)
		return
	}
	options, confirmation := []string{protocol}, false
	if protocol == "" {
		protocol, source = outcome.catalogProtocol, "catalog"
		options = []string{protocol}
		if protocol == ProtocolOpenAIChat {
			options = []string{ProtocolOpenAIChat, ProtocolOpenAIResponses}
			confirmation = true
		}
	}
	shared.JSON(w, 200, discoveryView{BaseURL: actualBase, Protocol: protocol, ProtocolOptions: options, ProtocolSource: source, RequiresConfirmation: confirmation, CapabilitiesVerified: false, Models: models, Truncated: outcome.truncated})
}

type directoryOutcome struct {
	success, fallback, retryProtocol, truncated bool
	status                                      int
	code, message, catalogProtocol              string
}

func directoryFailure(code, message string, fallback, retry bool) directoryOutcome {
	return directoryOutcome{status: 502, code: code, message: message, fallback: fallback, retryProtocol: retry}
}

func directoryTimeout() directoryOutcome {
	return directoryOutcome{status: 504, code: "timeout", message: "model directory request timed out"}
}

func (s *Service) fetchModels(parent context.Context, base, key string, usedSavedKey bool, profiles []string) ([]discoveryModel, string, directoryOutcome) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	client := *s.options.HTTPClient
	client.Timeout = 0
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("provider redirects are not allowed")
	}
	actualBase, fallbackUsed, requests := base, false, 0
	var outcome directoryOutcome
	var authenticationFailure directoryOutcome
	for _, profile := range profiles {
		if requests >= maxDiscoveryGETs {
			break
		}
		models, result := s.fetchDirectory(ctx, &client, actualBase, key, profile)
		requests++
		if result.success {
			return models, actualBase, result
		}
		root, parseErr := url.Parse(actualBase)
		if !usedSavedKey && !fallbackUsed && parseErr == nil && root.Path == "" && result.fallback && requests < maxDiscoveryGETs {
			// The sole version fallback becomes the fixed base for later profiles.
			// Saved credentials never participate in this address change.
			fallbackUsed = true
			version := "v1"
			if profile == ProtocolGoogle {
				version = "v1beta"
			}
			actualBase = appendAPIPath(actualBase, version)
			models, result = s.fetchDirectory(ctx, &client, actualBase, key, profile)
			requests++
			if result.success {
				return models, actualBase, result
			}
		}
		outcome = result
		if result.code == "credentials_rejected" {
			authenticationFailure = result
		}
		if !result.retryProtocol {
			break
		}
	}
	if outcome.code == "directory_unsupported" && authenticationFailure.code != "" {
		outcome = authenticationFailure
	}
	return nil, actualBase, outcome
}

func (s *Service) fetchDirectory(ctx context.Context, client *http.Client, base, key, profile string) ([]discoveryModel, directoryOutcome) {
	endpoint, err := url.Parse(appendAPIPath(base, "models"))
	if err != nil {
		return nil, directoryFailure("provider_unavailable", "cannot request model directory", false, false)
	}
	query := endpoint.Query()
	if profile == ProtocolAnthropic {
		query.Set("limit", "500")
	}
	if profile == ProtocolGoogle {
		query.Set("pageSize", "500")
	}
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, directoryFailure("provider_unavailable", "cannot request model directory", false, false)
	}
	req.Header.Set("Accept", "application/json")
	switch profile {
	case ProtocolAnthropic:
		req.Header.Set("Anthropic-Version", "2023-06-01")
		if key != "" {
			req.Header.Set("X-Api-Key", key)
		}
	case ProtocolGoogle:
		if key != "" {
			req.Header.Set("X-Goog-Api-Key", key)
		}
	default:
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, directoryTimeout()
		}
		return nil, directoryFailure("provider_unavailable", "model directory connection failed or redirected", false, false)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, directoryFailure("credentials_rejected", "model directory rejected credentials; enter a valid API key and check permissions", false, true)
	}
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed {
			return nil, directoryFailure("directory_unsupported", "model directory is unavailable; choose a protocol and enter the model name manually", true, true)
		}
		message := "model directory provider returned an error"
		if resp.StatusCode == http.StatusTooManyRequests {
			message = "model directory request was rate limited; retry later"
		}
		return nil, directoryFailure("provider_unavailable", message, false, false)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxDiscoveryBody+1))
	if readErr != nil {
		if errors.Is(readErr, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, directoryTimeout()
		}
		return nil, directoryFailure("provider_unavailable", "model directory response was interrupted", false, false)
	}
	if len(body) > maxDiscoveryBody {
		return nil, directoryFailure("provider_unavailable", "model directory response exceeds its size limit", false, false)
	}
	return parseDirectory(body, key)
}

func parseDirectory(body []byte, key string) ([]discoveryModel, directoryOutcome) {
	var directory struct {
		Data          json.RawMessage `json:"data"`
		Models        json.RawMessage `json:"models"`
		HasMore       *bool           `json:"has_more"`
		NextPageToken string          `json:"nextPageToken"`
	}
	unsupported := directoryFailure("directory_unsupported", "model directory format is unsupported; choose a protocol and enter the model name manually", true, true)
	if json.Unmarshal(body, &directory) != nil {
		return nil, unsupported
	}
	items, protocol, truncated := directory.Data, ProtocolOpenAIChat, false
	if directory.HasMore != nil {
		protocol, truncated = ProtocolAnthropic, *directory.HasMore
	}
	if directory.Models != nil {
		items, protocol, truncated = directory.Models, ProtocolGoogle, directory.NextPageToken != ""
	}
	if items == nil || string(items) == "null" {
		return nil, unsupported
	}
	var rawItems []json.RawMessage
	if json.Unmarshal(items, &rawItems) != nil {
		return nil, unsupported
	}
	set := make(map[string]struct{}, len(rawItems))
	for _, raw := range rawItems {
		var item struct {
			ID      string   `json:"id"`
			Name    string   `json:"name"`
			Type    string   `json:"type"`
			Methods []string `json:"supportedGenerationMethods"`
		}
		if json.Unmarshal(raw, &item) != nil {
			continue
		}
		id := item.ID
		if protocol == ProtocolGoogle {
			id = strings.TrimPrefix(item.Name, "models/")
			if len(item.Methods) > 0 {
				generates := false
				for _, method := range item.Methods {
					if method == "generateContent" || method == "streamGenerateContent" {
						generates = true
						break
					}
				}
				if !generates {
					continue
				}
			}
		} else if item.Type == "model" {
			protocol = ProtocolAnthropic
		}
		if strings.TrimSpace(id) == "" || len(id) > maxDiscoveryIDBytes || containsControl(id) || (key != "" && strings.Contains(id, key)) {
			continue
		}
		set[id] = struct{}{}
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) > maxDiscoveryModels {
		truncated = true
		ids = ids[:maxDiscoveryModels]
	}
	models := make([]discoveryModel, len(ids))
	for i, id := range ids {
		models[i] = discoveryModel{ID: id}
	}
	return models, directoryOutcome{success: true, truncated: truncated, status: 200, catalogProtocol: protocol}
}
