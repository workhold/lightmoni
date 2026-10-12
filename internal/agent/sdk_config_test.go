package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

func TestSDKConfigRelayLocalAuthAndOfflineCache(t *testing.T) {
	config := moni.SDKConfig{Revision: "one", LogSampling: map[string]moni.LogSamplingPolicy{"web": moni.DefaultLogSampling()}, DisableRules: []moni.LogExcludeRule{}}
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sdk-config" || r.Header.Get("Authorization") != "Bearer shared-global-key" {
			t.Error("bad relay auth")
			w.WriteHeader(401)
			return
		}
		_ = json.NewEncoder(w).Encode(config)
	}))
	cfg := testConfig(t)
	cfg.Endpoint = center.URL
	cfg.LocalToken = "local-token"
	a := newTestAgent(t, cfg)
	send := func(key string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/v1/sdk-config", nil)
		if key != "" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w
	}
	if w := send(""); w.Code != 401 {
		t.Fatal("missing local auth accepted")
	}
	first := send("local-token")
	if first.Code != 200 {
		t.Fatal(first.Code, first.Body)
	}
	center.Close()
	cached := send("local-token")
	if cached.Code != 200 || cached.Body.String() != first.Body.String() {
		t.Fatal("offline config lost", cached.Code, cached.Body)
	}
}
