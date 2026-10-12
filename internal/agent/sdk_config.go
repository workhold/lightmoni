package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

// The Agent relays the key-scoped configuration, keeping the center Key off
// business processes. It never re-samples frozen SDK payloads or metric data.
func (a *Agent) sdkConfigHandler(w http.ResponseWriter, r *http.Request) {
	if !a.authorizeLocal(r) {
		http.Error(w, "local token required", 401)
		return
	}
	a.sdkConfigMu.Lock()
	defer a.sdkConfigMu.Unlock()
	if r.Context().Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(a.cfg.Endpoint, "/")+"/v1/sdk-config", nil)
	if err != nil {
		http.Error(w, "configuration unavailable", 503)
		return
	}
	req.Header.Set("Authorization", "Bearer "+a.cfg.Key)
	response, err := a.http.Do(req)
	var raw []byte
	if err == nil {
		defer response.Body.Close()
		if response.StatusCode < 500 && response.StatusCode != 200 {
			http.Error(w, "configuration access denied", response.StatusCode)
			return
		}
		if response.StatusCode == 200 {
			raw, err = io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
			if len(raw) > 1<<20 {
				err = io.ErrShortBuffer
			}
		} else {
			err = io.ErrUnexpectedEOF
		}
	}
	path := filepath.Join(a.cfg.DataDir, "sdk-config.json")
	if err != nil {
		raw, err = os.ReadFile(path)
	}
	if err != nil {
		http.Error(w, "configuration unavailable", 503)
		return
	}
	config, err := moni.DecodeSDKConfig(bytes.NewReader(raw))
	if err != nil {
		http.Error(w, "invalid configuration", 503)
		return
	}
	// Cached configuration is validated on every read. An offline Agent can
	// restore its last configuration without rewriting queued business batches.
	if current, readErr := os.ReadFile(path); readErr != nil || !bytes.Equal(current, raw) {
		_ = atomicWrite(path, raw, 0600)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(config)
}
