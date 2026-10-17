package assistant

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

// Protocol-dependent URL repairs and catalog details live together. These are
// conservative conventions, not proof that a provider supports generation.
type modelProtocolRules struct {
	rootVersions   []string
	versionRepairs map[string]string
	catalogPath    string
	apiKeyHeader   string
	apiKeyPrefix   string
	catalogHeaders map[string]string
	catalogQuery   map[string]string
}

var modelProtocolRegistry = map[string]modelProtocolRules{
	ProtocolOpenAIChat: {
		rootVersions: []string{"v1"}, versionRepairs: map[string]string{"v1beta": "v1"}, catalogPath: "models",
		apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer ",
	},
	ProtocolOpenAIResponses: {
		rootVersions: []string{"v1"}, versionRepairs: map[string]string{"v1beta": "v1"}, catalogPath: "models",
		apiKeyHeader: "Authorization", apiKeyPrefix: "Bearer ",
	},
	ProtocolAnthropic: {
		rootVersions: []string{"v1"}, versionRepairs: map[string]string{"v1beta": "v1"}, catalogPath: "models",
		apiKeyHeader:   "X-Api-Key",
		catalogHeaders: map[string]string{"Anthropic-Version": "2023-06-01"},
		catalogQuery:   map[string]string{"limit": "500"},
	},
	ProtocolGoogle: {
		rootVersions: []string{"v1", "v1beta"}, catalogPath: "models",
		apiKeyHeader: "X-Goog-Api-Key",
		catalogQuery: map[string]string{"pageSize": "500"},
	},
}

// protocolAPIBase is shared by discovery, testing and saving. Credential
// identity must still use canonicalBaseIdentity on the saved address: repairing a
// requested address must never move a saved credential to a different base.
func protocolAPIBase(raw, protocol string) (string, error) {
	rules, ok := modelProtocolRegistry[protocol]
	if !ok {
		return "", errors.New("select a supported model protocol")
	}
	base, err := canonicalAPIBase(raw)
	if err != nil {
		return "", err
	}
	// Match literal final segments only. Encoded slashes and version names
	// belong to the custom path and must not be interpreted as version rules.
	if len(rules.versionRepairs) > 0 {
		u, err := url.Parse(base)
		if err != nil {
			return "", err
		}
		for from, to := range rules.versionRepairs {
			if strings.HasSuffix(u.EscapedPath(), "/"+from) {
				base = strings.TrimSuffix(base, "/"+from) + "/" + to
				break
			}
		}
	}
	return base, nil
}

// protocolDiscoveryCandidates accepts the already normalized profile base.
// Extracting endpoint suffixes again would alter legitimate nested base paths.
func protocolDiscoveryCandidates(base, protocol string, usedSavedKey bool) ([]string, error) {
	rules, ok := modelProtocolRegistry[protocol]
	if !ok {
		return nil, errors.New("select a supported model protocol")
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if usedSavedKey || u.EscapedPath() != "" {
		return []string{base}, nil
	}
	candidates := make([]string, 0, len(rules.rootVersions)+1)
	for _, version := range rules.rootVersions {
		candidates = append(candidates, appendAPIPath(base, version))
	}
	return append(candidates, base), nil
}

func protocolDirectoryRequest(ctx context.Context, base, key, protocol string) (*http.Request, error) {
	rules, ok := modelProtocolRegistry[protocol]
	if !ok {
		return nil, errors.New("select a supported model protocol")
	}
	endpoint, err := url.Parse(appendAPIPath(base, rules.catalogPath))
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	for name, value := range rules.catalogQuery {
		query.Set(name, value)
	}
	endpoint.RawQuery = query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	for name, value := range rules.catalogHeaders {
		req.Header.Set(name, value)
	}
	if key != "" {
		req.Header.Set(rules.apiKeyHeader, rules.apiKeyPrefix+key)
	}
	return req, nil
}
