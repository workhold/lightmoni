package server

import (
	"bytes"
	"io/fs"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedAgentDownloadsRequireActiveKey(t *testing.T) {
	s := testGroupServer(t)
	if err := s.registerAgentInstall("https://monitor.example"); err != nil {
		t.Fatal(err)
	}
	files := []string{"install.sh", "uninstall.sh"}
	if _, err := fs.Stat(assets, "agent-dist/SHA256SUMS"); err == nil {
		files = append(files, "SHA256SUMS")
	}
	entries, err := fs.ReadDir(assets, "agent-dist")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "lightmoni-agent_") && strings.HasSuffix(entry.Name(), ".tar.gz") {
			files = append(files, entry.Name())
		}
	}
	for _, file := range files {
		for _, authorization := range []string{"", "Bearer invalid", "agent-test-key"} {
			r := httptest.NewRequest("GET", "/downloads/agent/"+file, nil)
			r.Header.Set("Authorization", authorization)
			// Browser login alone must not bypass the explicit download-key requirement.
			r.Header.Set("Cookie", "lm_session=unused")
			w := httptest.NewRecorder()
			s.Public.ServeHTTP(w, r)
			if w.Code != 401 {
				t.Fatal("unauthenticated download", file, w.Code)
			}
		}
		r := httptest.NewRequest("GET", "/downloads/agent/"+file, nil)
		r.Header.Set("Authorization", "Bearer agent-test-key")
		w := httptest.NewRecorder()
		s.Public.ServeHTTP(w, r)
		raw, err := fs.ReadFile(assets, "agent-dist/"+file)
		if err != nil || w.Code != 200 || !bytes.Equal(w.Body.Bytes(), raw) || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatal("authenticated embedded download", file, w.Code, err)
		}
	}
	if _, err = s.DB.Exec("UPDATE ingest_keys SET active=0 WHERE id='agent-key'"); err != nil {
		t.Fatal(err)
	}
	w := groupRequest(t, s, true, "", "GET", "/downloads/agent/install.sh", nil)
	if w.Code != 401 {
		t.Fatal("disabled key downloaded agent", w.Code)
	}
}
