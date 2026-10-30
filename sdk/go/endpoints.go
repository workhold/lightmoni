package moni

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type centerAddress struct {
	URL   string `json:"url"`
	Scope string `json:"scope"`
}
type centerManifest struct {
	Version   int             `json:"version"`
	CenterID  string          `json:"center_id"`
	Revision  string          `json:"revision"`
	Endpoints []centerAddress `json:"endpoints"`
}
type centerEndpoints struct {
	pending                sync.Map
	mu                     sync.Mutex
	bootstrap, selected    string
	expires, selectedUntil time.Time
	manifest               *centerManifest
	failed                 map[string]time.Time
}

func newCenterEndpoints(endpoint string) *centerEndpoints {
	return &centerEndpoints{bootstrap: strings.TrimRight(endpoint, "/"), failed: map[string]time.Time{}}
}
func validCenterURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil {
		return false
	}
	if u.Port() != "" {
		n, e := strconv.Atoi(u.Port())
		if e != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return u.Hostname() != "" && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.RawQuery == "" && u.Fragment == "" && !strings.ContainsAny(value, "?#\\ \r\n\t")
}
func centerJSON(ctx context.Context, client *http.Client, address, key string, target any) error {
	child, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(child, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	// Never let a caller-supplied HTTP client redirect discovery credentials.
	bounded := *client
	bounded.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := bounded.Do(request)
	if err != nil {
		return errors.New("center discovery unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return errors.New("center discovery access denied")
	}
	if response.StatusCode != 200 {
		return errors.New("center discovery unsupported or unavailable")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return errors.New("invalid center discovery response")
	}
	return json.Unmarshal(raw, target)
}
func (e *centerEndpoints) resolve(ctx context.Context, client *http.Client, key string, force bool) (string, error) {
	child, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ctx = child
	for !e.mu.TryLock() {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
	defer e.mu.Unlock()
	now := time.Now()
	verified := ""
	e.pending.Range(func(k, v any) bool {
		e.failed[k.(string)] = v.(time.Time)
		e.selectedUntil = time.Time{}
		e.pending.Delete(k)
		return true
	})
	if force {
		e.expires = time.Time{}
		e.selectedUntil = time.Time{}
	}
	if now.Before(e.selectedUntil) && e.selected != "" {
		return e.selected, nil
	}
	if !now.Before(e.expires) {
		e.expires = now.Add(30 * time.Second)
		sources := []string{e.bootstrap}
		if e.selected != "" && e.selected != e.bootstrap {
			sources = []string{e.selected, e.bootstrap}
		}
		if e.manifest != nil {
			for _, candidate := range e.manifest.Endpoints {
				if candidate.Scope == "public" && candidate.URL != e.selected && candidate.URL != e.bootstrap {
					sources = append(sources, candidate.URL)
				}
			}
		}
		for _, source := range sources {
			if e.manifest != nil {
				var identity struct {
					CenterID string `json:"center_id"`
				}
				if centerJSON(ctx, client, source+"/v1/center-identity", "", &identity) != nil || identity.CenterID != e.manifest.CenterID {
					continue
				}
			}
			var manifest centerManifest
			err := centerJSON(ctx, client, source+"/v1/center-endpoints", key, &manifest)
			if err != nil {
				if err.Error() == "center discovery access denied" {
					return "", err
				}
				continue
			}
			valid := manifest.Version == 1 && manifest.CenterID != "" && len(manifest.CenterID) <= 128 && manifest.Revision != "" && len(manifest.Endpoints) > 0 && len(manifest.Endpoints) <= 20 && (e.manifest == nil || e.manifest.CenterID == manifest.CenterID)
			public := false
			for i, a := range manifest.Endpoints {
				if !validCenterURL(a.URL) || (a.Scope != "internal" && a.Scope != "public") {
					valid = false
				}
				public = public || a.Scope == "public"
				manifest.Endpoints[i].URL = strings.TrimRight(a.URL, "/")
			}
			if !valid || !public {
				continue
			}
			if e.manifest == nil || manifest.Revision != e.manifest.Revision {
				e.failed = map[string]time.Time{}
			}
			e.manifest = &manifest
			verified = source
			break
		}
	}
	if e.manifest == nil {
		e.selected = e.bootstrap
		e.selectedUntil = e.expires
		return e.selected, nil
	}
	candidates := append([]centerAddress{}, e.manifest.Endpoints...)
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Scope == "internal" && candidates[j].Scope == "public" })
	found := false
	for _, a := range candidates {
		found = found || a.URL == e.bootstrap
	}
	if !found {
		candidates = append(candidates, centerAddress{e.bootstrap, "public"})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Scope != candidates[j].Scope {
			return candidates[i].Scope == "internal"
		}
		return (candidates[i].URL == verified || candidates[i].URL == e.bootstrap) && !(candidates[j].URL == verified || candidates[j].URL == e.bootstrap)
	})
	deadline := time.Now().Add(3 * time.Second)
	for _, a := range candidates {
		if now.Before(e.failed[a.URL]) || (a.Scope == "internal" && time.Now().After(deadline)) {
			continue
		}
		if a.URL == verified {
			e.selected = a.URL
			e.selectedUntil = e.expires
			return a.URL, nil
		}
		if ctx.Err() != nil {
			break
		}
		var identity struct {
			CenterID string `json:"center_id"`
		}
		if centerJSON(ctx, client, a.URL+"/v1/center-identity", "", &identity) == nil && identity.CenterID == e.manifest.CenterID {
			e.selected = a.URL
			e.selectedUntil = e.expires
			return a.URL, nil
		}
		if ctx.Err() == nil {
			e.failed[a.URL] = now.Add(30 * time.Second)
		}
	}
	return "", errors.New("no verified center endpoint is reachable")
}
func (e *centerEndpoints) failure(endpoint string) {
	e.pending.Store(endpoint, time.Now().Add(30*time.Second))
}

// Notify on a real body read error; malformed JSON does not change routing.
type centerResponseBody struct {
	io.ReadCloser
	selector *centerEndpoints
	endpoint string
}

func (b *centerResponseBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err != nil && err != io.EOF && centerTransportFailure(err) {
		b.selector.failure(b.endpoint)
	}
	return n, err
}

// RefreshEndpoints queries the center and immediately re-evaluates internal access.
func (c *Client) RefreshEndpoints(ctx context.Context) error {
	exporter, ok := c.s.cfg.Exporter.(*HTTPExporter)
	if !ok {
		return nil
	}
	exporter.mu.RLock()
	key := exporter.key
	exporter.mu.RUnlock()
	_, err := exporter.endpoints.resolve(ctx, exporter.Client, key, true)
	return err
}

// Certificate failures are configuration errors, not network failover signals.
func centerTransportFailure(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	var certificate *tls.CertificateVerificationError
	var invalid x509.CertificateInvalidError
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	return !errors.As(err, &certificate) && !errors.As(err, &invalid) && !errors.As(err, &unknown) && !errors.As(err, &hostname)
}
