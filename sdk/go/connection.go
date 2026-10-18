package moni

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// NewFromEnv constructs a client using the cross-language LIGHTMONI_* contract.
// Explicit Config fields still take precedence when callers need a secret
// manager integration; *_FILE is preferred over plain environment variables.
func NewFromEnv(service, table string, cfg Config) (*Client, error) {
	mode, err := envValue("LIGHTMONI_MODE", string(cfg.Mode), "direct")
	if err != nil {
		return nil, err
	}
	cfg.Mode = ConnectionMode(mode)
	if cfg.Endpoint == "" {
		cfg.Endpoint = os.Getenv("LIGHTMONI_ENDPOINT")
	}
	if cfg.AgentEndpoint == "" {
		cfg.AgentEndpoint = os.Getenv("LIGHTMONI_AGENT_ENDPOINT")
	}
	if cfg.AgentEndpoint == "" {
		cfg.AgentEndpoint = "http://127.0.0.1:4318"
	}
	if cfg.LocalToken == "" {
		cfg.LocalToken, cfg.LocalTokenFile, err = secretValue("local token", cfg.LocalToken, cfg.LocalTokenFile, "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE")
		if err != nil {
			return nil, err
		}
	}
	explicitData := cfg.DataKey
	if explicitData == "" {
		explicitData = cfg.Key
	}
	cfg.DataKey, cfg.DataKeyFile, err = secretValue("data key", explicitData, cfg.DataKeyFile, "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE")
	if err != nil {
		return nil, err
	}
	legacy, _, legacyErr := secretValue("legacy data key", "", "", "LIGHTMONI_KEY", "")
	if legacyErr != nil {
		return nil, legacyErr
	}
	if cfg.DataKey != "" && legacy != "" && cfg.DataKey != legacy {
		return nil, errors.New("credential_source_conflict: LIGHTMONI_KEY")
	}
	if cfg.DataKey == "" {
		cfg.DataKey = legacy
	}
	if cfg.DataKey != "" {
		cfg.Key = cfg.DataKey
	}
	if cfg.Key == "" {
		cfg.Key = cfg.DataKey
	}
	return New(cfgWithService(service, table, cfg))
}

// ResolveConnection is exported for applications that want diagnostics before
// constructing a client. It never returns secret values.
func ResolveConnection(c ConnectionConfig) (ConnectionConfig, string, error) {
	mode := c.Mode
	if mode == "" {
		mode = ModeDirect
	}
	if mode != ModeAgent && mode != ModeDirect && mode != ModeAuto {
		return c, "", errors.New("mode must be agent, direct, or auto")
	}
	if c.DiscoveryTimeout == 0 {
		c.DiscoveryTimeout = 500 * time.Millisecond
	}
	if c.AgentEndpoint == "" {
		c.AgentEndpoint = "http://127.0.0.1:4318"
	}
	if mode == ModeAgent {
		if _, err := validHTTPURL(c.AgentEndpoint); err != nil {
			return c, "", fmt.Errorf("agent endpoint: %w", err)
		}
		return c, "agent", nil
	}
	if mode == ModeDirect {
		if c.Endpoint == "" || c.DataKey == "" {
			return c, "", errors.New("direct mode requires endpoint and data key")
		}
		if _, err := validHTTPURL(c.Endpoint); err != nil {
			return c, "", err
		}
		return c, "direct", nil
	}
	if _, err := validHTTPURL(c.AgentEndpoint); err != nil {
		return c, "", fmt.Errorf("agent endpoint: %w", err)
	}
	probeErr := probeAgent(c.AgentEndpoint, c.LocalToken, c.DiscoveryTimeout)
	if probeErr == nil {
		return c, "agent", nil
	}
	if strings.HasPrefix(probeErr.Error(), "agent probe HTTP") {
		return c, "", probeErr
	}
	if c.Endpoint == "" || c.DataKey == "" {
		return c, "", errors.New("auto_route_unavailable: agent unavailable and direct credentials are missing")
	}
	if _, err := validHTTPURL(c.Endpoint); err != nil {
		return c, "", err
	}
	return c, "direct", nil
}

func cfgWithService(service, table string, c Config) Config {
	c.Service, c.Table = service, table
	return c
}

func envValue(name, explicit, fallback string) (string, error) {
	if explicit != "" {
		if v := os.Getenv(name); v != "" && v != explicit {
			return "", errors.New("credential_source_conflict: " + name)
		}
		return explicit, nil
	}
	if v := os.Getenv(name); v != "" {
		return v, nil
	}
	return fallback, nil
}

func secretValue(label, explicit, file, env, fileEnv string) (string, string, error) {
	if file == "" {
		file = os.Getenv(fileEnv)
	}
	fromFile := ""
	if file != "" {
		info, err := os.Lstat(file)
		if err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return "", file, fmt.Errorf("%s file must be a regular file", label)
		}
		b, err := os.ReadFile(file)
		if err != nil {
			return "", file, fmt.Errorf("%s file: %w", label, err)
		}
		if len(b) > 16<<10 {
			return "", file, fmt.Errorf("%s file is too large", label)
		}
		fromFile = strings.TrimSuffix(strings.TrimSuffix(string(b), "\n"), "\r")
	}
	fromEnv := os.Getenv(env)
	if explicit != "" && ((fromFile != "" && fromFile != explicit) || (fromEnv != "" && fromEnv != explicit)) || fromFile != "" && fromEnv != "" && fromFile != fromEnv {
		return "", file, errors.New("credential_source_conflict: " + env)
	}
	if explicit != "" {
		return explicit, file, nil
	}
	if fromFile != "" {
		return fromFile, file, nil
	}
	return fromEnv, file, nil
}

func validHTTPURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("endpoint must be an absolute HTTP(S) URL")
	}
	return u, nil
}
func probeAgent(endpoint, token string, timeout time.Duration) error {
	if timeout < 50*time.Millisecond {
		timeout = 50 * time.Millisecond
	}
	if timeout > 2*time.Second {
		timeout = 2 * time.Second
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(endpoint, "/")+"/healthz", nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 1024)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("agent probe HTTP %d", resp.StatusCode)
	}
	return nil
}
