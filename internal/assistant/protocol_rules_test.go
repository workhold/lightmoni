package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestProtocolRulesNormalizeOnlyLiteralVersionPath(t *testing.T) {
	for _, tc := range []struct{ input, protocol, want string }{
		{"https://v1beta", ProtocolAnthropic, "https://v1beta"},
		{"https://v1beta:443/", ProtocolOpenAIChat, "https://v1beta"},
		{"https://v1beta/v1beta", ProtocolOpenAIResponses, "https://v1beta/v1"},
		{"https://api.example/tenant/v1%62eta", ProtocolAnthropic, "https://api.example/tenant/v1%62eta"},
		{"https://api.example/tenant%2Fv1beta", ProtocolAnthropic, "https://api.example/tenant%2Fv1beta"},
		{"https://api.example/tenant%2Fprivate/v1beta", ProtocolAnthropic, "https://api.example/tenant%2Fprivate/v1"},
		{"https://v1beta/v1beta", ProtocolGoogle, "https://v1beta/v1beta"},
	} {
		t.Run(tc.protocol+tc.input, func(t *testing.T) {
			got, err := protocolAPIBase(tc.input, tc.protocol)
			if err != nil || got != tc.want {
				t.Fatalf("protocol repair changed URL identity: got %q err=%v want=%q", got, err, tc.want)
			}
		})
	}
}

func TestProtocolRulesDiscoveryUsesSelectedVersionBeforeSharedCatalog(t *testing.T) {
	for _, protocol := range []string{ProtocolOpenAIChat, ProtocolOpenAIResponses, ProtocolAnthropic} {
		for _, tc := range []struct{ input, want string }{
			{"/v1beta", "/v1"},
			{"/tenant/v1beta/messages/", "/tenant/v1"},
			{"/tenant%2Fprivate/v1beta/models", "/tenant%2Fprivate/v1"},
			{"/tenant%2fprivate/v1beta/chat/completions", "/tenant%2fprivate/v1"},
			{"/tenant%2Fv1beta", "/tenant%2Fv1beta"},
			{"/tenant/%76%31beta", "/tenant/%76%31beta"},
			{"/v1beta/tenant", "/v1beta/tenant"},
			{"/tenant/v2", "/tenant/v2"},
			{"/compatible-mode/v1", "/compatible-mode/v1"},
		} {
			t.Run(protocol+tc.input, func(t *testing.T) {
				var paths []string
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					paths = append(paths, r.URL.EscapedPath())
					if protocol == ProtocolAnthropic {
						if r.Header.Get("X-Api-Key") != "temporary-secret" || r.Header.Get("Authorization") != "" {
							t.Error("version repair changed the selected Anthropic authentication")
						}
					} else if r.Header.Get("Authorization") != "Bearer temporary-secret" || r.Header.Get("X-Api-Key") != "" {
						t.Error("version repair changed the selected OpenAI authentication")
					}
					// A gateway exposes a shared catalog at every path, including the
					// unsuitable beta path. Only the selected protocol's base is valid.
					fmt.Fprint(w, `{"data":[{"id":"shared-model"}]}`)
				}))
				defer provider.Close()
				_, server := fixtureService(t, nil)
				status, body := modelProtocolRequest(t, server, provider.URL+tc.input, "temporary-secret", false, protocol)
				if status != http.StatusOK {
					t.Fatalf("version-aware discovery: %d %s", status, body)
				}
				result := decodeModels(t, body)
				if result.BaseURL != provider.URL+tc.want || result.Protocol != protocol || result.ProtocolSource != "manual" || result.RequiresConfirmation || result.CapabilitiesVerified {
					t.Fatalf("incorrect repaired discovery: %s", body)
				}
				if !reflect.DeepEqual(paths, []string{tc.want + "/models"}) {
					t.Fatalf("shared catalog bypassed protocol repair: %v", paths)
				}
			})
		}
	}
}

func TestProtocolRulesRootCompletionPrefersStableVersion(t *testing.T) {
	for _, tc := range []struct {
		name, protocol, input, success, wantBase string
		paths                                    []string
	}{
		{"chat-stable-first", ProtocolOpenAIChat, "", "/v1/models", "/v1", []string{"/v1/models"}},
		{"responses-stable-first", ProtocolOpenAIResponses, "", "/v1/models", "/v1", []string{"/v1/models"}},
		{"anthropic-stable-first", ProtocolAnthropic, "", "/v1/models", "/v1", []string{"/v1/models"}},
		{"google-stable-first", ProtocolGoogle, "", "/v1/models", "/v1", []string{"/v1/models"}},
		{"google-beta-fallback", ProtocolGoogle, "", "/v1beta/models", "/v1beta", []string{"/v1/models", "/v1beta/models"}},
		{"google-root-last", ProtocolGoogle, "", "/models", "", []string{"/v1/models", "/v1beta/models", "/models"}},
		{"google-explicit-beta", ProtocolGoogle, "/tenant%2Fprivate/v1beta", "/tenant%2Fprivate/v1beta/models", "/tenant%2Fprivate/v1beta", []string{"/tenant%2Fprivate/v1beta/models"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var paths []string
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				path := r.URL.EscapedPath()
				paths = append(paths, path)
				if path != tc.success {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				if tc.protocol == ProtocolGoogle {
					if r.Header.Get("X-Goog-Api-Key") != "directory-secret" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
						t.Error("Google completion used another protocol's authentication")
					}
					fmt.Fprint(w, `{"models":[{"name":"models/native-model"}]}`)
					return
				}
				fmt.Fprint(w, `{"data":[{"id":"native-model"}]}`)
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, body := modelProtocolRequest(t, server, provider.URL+tc.input, "directory-secret", false, tc.protocol)
			if status != http.StatusOK {
				t.Fatalf("root completion: %d %s", status, body)
			}
			result := decodeModels(t, body)
			if result.BaseURL != provider.URL+tc.wantBase || result.Protocol != tc.protocol || len(result.Models) != 1 || result.Models[0].ID != "native-model" || !reflect.DeepEqual(paths, tc.paths) {
				t.Fatalf("incorrect root completion: %s paths=%v want=%v", body, paths, tc.paths)
			}
		})
	}
}

func TestProtocolRulesAutomaticRootExhaustsOnlySevenCandidates(t *testing.T) {
	for _, providerStatus := range []int{http.StatusNotFound, http.StatusUnauthorized} {
		t.Run(fmt.Sprintf("status-%d", providerStatus), func(t *testing.T) {
			var paths []string
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.EscapedPath())
				w.WriteHeader(providerStatus)
				fmt.Fprint(w, "private-provider-body")
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, body := modelProtocolRequest(t, server, provider.URL, "directory-secret", false, "auto")
			want := []string{"/v1/models", "/models", "/v1/models", "/models", "/v1/models", "/v1beta/models", "/models"}
			code := "directory_unsupported"
			if providerStatus == http.StatusUnauthorized {
				code = "credentials_rejected"
			}
			if status != http.StatusBadGateway || !bytes.Contains(body, []byte(`"code":"`+code+`"`)) || !reflect.DeepEqual(paths, want) || bytes.Contains(body, []byte("private-provider-body")) || bytes.Contains(body, []byte("directory-secret")) {
				t.Fatalf("unbounded or incorrect profile attempts: %d %s paths=%v", status, body, paths)
			}
		})
	}
}

func TestProtocolRulesGoogleStopsOnProviderFailure(t *testing.T) {
	for _, providerStatus := range []int{http.StatusTooManyRequests, http.StatusInternalServerError} {
		t.Run(fmt.Sprintf("status-%d", providerStatus), func(t *testing.T) {
			var paths []string
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.EscapedPath())
				w.WriteHeader(providerStatus)
			}))
			defer provider.Close()
			_, server := fixtureService(t, nil)
			status, body := modelProtocolRequest(t, server, provider.URL, "", false, ProtocolGoogle)
			if status != http.StatusBadGateway || !reflect.DeepEqual(paths, []string{"/v1/models"}) {
				t.Fatalf("provider failure caused blind fallback: %d %s paths=%v", status, body, paths)
			}
		})
	}
}

func TestProtocolRulesSavedKeyRemainsBoundToStoredDestination(t *testing.T) {
	for _, tc := range []struct {
		name, stored, input, protocol, wantBase string
		allow                                   bool
	}{
		{"legacy-beta-key-cannot-move", "/tenant/v1beta", "/tenant/v1beta", ProtocolAnthropic, "", false},
		{"chat-legacy-beta-key-cannot-move", "/tenant/v1beta", "/tenant/v1beta", ProtocolOpenAIChat, "", false},
		{"repaired-input-matches-stored-base", "/tenant/v1", "/tenant/v1beta", ProtocolAnthropic, "/tenant/v1", true},
		{"escaped-prefix-repair", "/tenant%2Fprivate/v1", "/tenant%2Fprivate/v1beta/messages", ProtocolAnthropic, "/tenant%2Fprivate/v1", true},
		{"encoded-tenant-is-distinct", "/tenant%2Fprivate/v1", "/tenant/private/v1beta", ProtocolAnthropic, "", false},
		{"different-tenant-is-distinct", "/tenant/v1", "/other/v1beta", ProtocolAnthropic, "", false},
		{"google-keeps-stored-beta", "/tenant/v1beta", "/tenant/v1beta", ProtocolGoogle, "/tenant/v1beta", true},
		{"automatic-can-use-google-at-stored-beta", "/tenant/v1beta", "/tenant/v1beta", "auto", "/tenant/v1beta", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var paths []string
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.EscapedPath())
				if tc.protocol == ProtocolGoogle || tc.protocol == "auto" {
					if r.Header.Get("X-Goog-Api-Key") != "saved-secret" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" {
						t.Error("stored beta credential reached an incompatible profile")
					}
					fmt.Fprint(w, `{"models":[{"name":"models/saved-model"}]}`)
					return
				}
				if r.Header.Get("X-Api-Key") != "saved-secret" {
					t.Error("saved credential was not sent to its matching base")
				}
				fmt.Fprint(w, `{"data":[{"id":"saved-model"}]}`)
			}))
			defer provider.Close()
			s, server := fixtureService(t, nil)
			// Model an already-stored configuration. Saving through the public
			// endpoint would first apply the new protocol's repair policy.
			stored, err := json.Marshal(Config{BaseURL: provider.URL + tc.stored, Protocol: ProtocolAnthropic, Model: "saved-model", APIKey: "saved-secret"})
			if err != nil {
				t.Fatal(err)
			}
			if err := s.options.Store.Put(context.Background(), "config", stored); err != nil {
				t.Fatal(err)
			}
			status, body := modelProtocolRequest(t, server, provider.URL+tc.input, "", true, tc.protocol)
			if tc.allow {
				if status != http.StatusOK || decodeModels(t, body).BaseURL != provider.URL+tc.wantBase || !reflect.DeepEqual(paths, []string{tc.wantBase + "/models"}) {
					t.Fatalf("safe saved credential rejected: %d %s paths=%v", status, body, paths)
				}
			} else if status != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"saved_key_mismatch"`)) || len(paths) != 0 {
				t.Fatalf("saved credential crossed its stored base: %d %s paths=%v", status, body, paths)
			}
			after, err := s.options.Store.Get(context.Background(), "config")
			if err != nil || !bytes.Equal(stored, after) || bytes.Contains(body, []byte("saved-secret")) {
				t.Fatalf("discovery modified configuration or disclosed credential: err=%v", err)
			}
		})
	}
}
