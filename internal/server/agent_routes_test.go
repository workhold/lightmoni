package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAgentGroupRoutesRegisterWithoutConflict(t *testing.T) {
	s := &Server{API: http.NewServeMux()}
	s.registerAgentConfig()
	for _, tc := range []struct{ path, pattern string }{
		{"/api/v1/agent-groups/default", "PUT /api/v1/agent-groups/{group}"},
		{"/api/v1/agents/local/group", "PUT /api/v1/agents/{id}/group"},
	} {
		_, pattern := s.API.Handler(httptest.NewRequest("PUT", tc.path, nil))
		if pattern != tc.pattern {
			t.Fatalf("%s matched %q, want %q", tc.path, pattern, tc.pattern)
		}
	}
}
