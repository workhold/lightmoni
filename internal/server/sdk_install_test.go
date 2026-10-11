package server

import (
	"bytes"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSDKCatalogAndDownloadRoutes(t *testing.T) {
	s := &Server{API: http.NewServeMux(), Public: http.NewServeMux()}
	s.registerAgentInstall("https://monitor.example/base/")
	r := httptest.NewRecorder()
	s.API.ServeHTTP(r, httptest.NewRequest("GET", "/api/v1/sdk-install", nil))
	var metadata struct {
		Version  string       `json:"version"`
		Packages []sdkPackage `json:"packages"`
		NodeURL  string       `json:"node_url"`
		GoURL    string       `json:"go_url"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	if r.Code != 200 || len(metadata.Packages) != 8 || metadata.Version != sdkVersion || metadata.NodeURL == "" || metadata.GoURL == "" {
		t.Fatalf("invalid SDK install metadata: %s", r.Body.String())
	}
	for _, p := range metadata.Packages {
		if !strings.HasPrefix(p.URL, "https://monitor.example/base/downloads/sdk/") {
			t.Fatalf("wrong SDK URL: %s", p.URL)
		}
		response := httptest.NewRecorder()
		s.Public.ServeHTTP(response, httptest.NewRequest("GET", "/downloads/sdk/"+p.File, nil))
		raw, err := fs.ReadFile(assets, "agent-dist/"+p.File)
		if err != nil {
			if p.Available || response.Code != 404 {
				t.Fatalf("missing package marked available: %s", p.ID)
			}
			continue
		}
		if !p.Available || response.Code != 200 || !bytes.Equal(raw, response.Body.Bytes()) || response.Header().Get("Content-Disposition") == "" {
			t.Fatalf("download mismatch for %s", p.ID)
		}
	}
	for _, file := range []string{"install.sh", "config.json", "lightmoni-agent_0.1.0_linux_arm64.tar.gz", "lightmoni-python-sdk_999.tar.gz"} {
		response := httptest.NewRecorder()
		s.Public.ServeHTTP(response, httptest.NewRequest("GET", "/downloads/sdk/"+file, nil))
		if response.Code != 404 {
			t.Fatalf("unlisted file exposed: %s", file)
		}
	}
}
