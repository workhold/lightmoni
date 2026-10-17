package assistant

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

const (
	maxDiscoveryBody    = 1 << 20
	maxDiscoveryModels  = 500
	maxDiscoveryIDBytes = 200
	maxDiscoveryGETs    = 7
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
	_, err := canonicalAPIBase(input.BaseURL)
	if err != nil || len(input.APIKey) > 4096 || containsControl(input.APIKey) {
		discoveryError(w, 400, "invalid_input", "invalid model discovery input")
		return
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
	models, actualBase, outcome := s.fetchModels(r.Context(), input.BaseURL, input.APIKey, input.UseSavedKey, profiles)
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

func (s *Service) fetchModels(parent context.Context, base, explicitKey string, useSavedKey bool, profiles []string) ([]discoveryModel, string, directoryOutcome) {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	client := *s.options.HTTPClient
	client.Timeout = 0
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("provider redirects are not allowed")
	}
	requests := 0
	var outcome directoryOutcome
	var authenticationFailure directoryOutcome
	var savedKeyFailure directoryOutcome
	usedSavedKey := explicitKey == "" && useSavedKey
	stop := false
	for _, profile := range profiles {
		if stop || requests >= maxDiscoveryGETs {
			break
		}
		profileBase, err := protocolAPIBase(base, profile)
		if err != nil {
			return nil, base, directoryOutcome{status: 400, code: "invalid_input", message: "invalid model discovery input"}
		}
		// Normalize the destination before resolving a saved key. In auto mode
		// an incompatible profile may be skipped, but the original saved base
		// is never normalized under that profile to make its credential match.
		key, err := s.connectionKey(ctx, profileBase, explicitKey, useSavedKey)
		if err != nil {
			status, code := 400, "saved_key_mismatch"
			var keyErr *connectionKeyError
			if errors.As(err, &keyErr) {
				status, code = keyErr.status, keyErr.code
			}
			failure := directoryOutcome{status: status, code: code, message: err.Error()}
			if code != "saved_key_mismatch" {
				return nil, base, failure
			}
			savedKeyFailure = failure
			continue
		}
		// Candidates belong to their own profile. Only fresh/keyless roots may
		// probe version alternatives; saved keys stay at their exact base.
		candidates, err := protocolDiscoveryCandidates(profileBase, profile, usedSavedKey)
		if err != nil {
			return nil, base, directoryOutcome{status: 400, code: "invalid_input", message: "invalid model discovery input"}
		}
		for index, candidate := range candidates {
			if requests >= maxDiscoveryGETs {
				stop = true
				break
			}
			models, result := s.fetchDirectory(ctx, &client, candidate, key, profile)
			requests++
			if result.success {
				return models, candidate, result
			}
			outcome = result
			if result.code == "credentials_rejected" {
				authenticationFailure = result
			}
			// Alternate version candidates are bounded repairs for unsupported
			// or authentication responses, never generation probes.
			if index+1 < len(candidates) && result.fallback {
				continue
			}
			if !result.retryProtocol {
				stop = true
			}
			break
		}
	}
	if outcome.code == "" && savedKeyFailure.code != "" {
		outcome = savedKeyFailure
	}
	if (outcome.code == "directory_unsupported" || outcome.code == "provider_unavailable") && authenticationFailure.code != "" {
		outcome = authenticationFailure
	}
	return nil, base, outcome
}

func (s *Service) fetchDirectory(ctx context.Context, client *http.Client, base, key, profile string) ([]discoveryModel, directoryOutcome) {
	req, err := protocolDirectoryRequest(ctx, base, key, profile)
	if err != nil {
		return nil, directoryFailure("provider_unavailable", "cannot request model directory", false, false)
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
		// Keep this eligible for a same-origin version candidate when the
		// caller supplied a fresh key. fetchModels gates the fallback on root
		// URL and saved-key state; the error remains authentication-specific if
		// every candidate fails.
		return nil, directoryFailure("credentials_rejected", "model directory rejected credentials; enter a valid API key and check permissions", true, true)
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
	return parseDirectory(body, key, profile)
}

func parseDirectory(body []byte, key, profile string) ([]discoveryModel, directoryOutcome) {
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
	// The response envelope is only a directory shape. Gateways frequently
	// expose a Gemini-shaped `models` list from an OpenAI-compatible endpoint,
	// so the profile that successfully authenticated and served the directory
	// is the protocol recommendation. The envelope still determines how IDs
	// and pagination are read.
	protocol := profile
	if protocol == "" || protocol == "auto" {
		protocol = ProtocolOpenAIChat
		if directory.HasMore != nil {
			protocol = ProtocolAnthropic
		} else if directory.Models != nil {
			protocol = ProtocolGoogle
		}
	}
	items := directory.Data
	if profile == ProtocolGoogle || items == nil || string(items) == "null" {
		if directory.Models != nil {
			items = directory.Models
		}
	}
	truncated := false
	if directory.HasMore != nil {
		truncated = *directory.HasMore
	}
	if directory.NextPageToken != "" {
		truncated = true
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
		if directory.Models != nil && (profile == ProtocolGoogle || directory.Data == nil || string(directory.Data) == "null") {
			id = strings.TrimPrefix(item.Name, "models/")
			if profile == ProtocolGoogle && len(item.Methods) > 0 {
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
		} else if id == "" && item.Name != "" {
			// Some OpenAI-compatible gateways use the Google `models` envelope
			// while still returning IDs under `name`.
			id = strings.TrimPrefix(item.Name, "models/")
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
