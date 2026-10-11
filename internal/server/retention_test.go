package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/ingest"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
)

func TestRetentionAPIValidationAndPermissions(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ch := storage.NewClickHouse("http://unused.invalid", "fixture", "")
	c, err := ingest.NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{DB: db, Catalog: c, API: http.NewServeMux()}
	s.registerRetention()
	for _, test := range []struct {
		method, path, body, role string
		status                   int
	}{
		{"GET", "/api/v1/settings/retention", "", "member", 200},
		{"PUT", "/api/v1/settings/retention", `{"default_days":14}`, "member", 403},
		{"PUT", "/api/v1/settings/retention", `{"default_days":14}`, "admin", 200},
		{"PUT", "/api/v1/settings/retention", `{}`, "admin", 400},
		{"PUT", "/api/v1/settings/retention", `{"default_days":null}`, "admin", 400},
		{"PUT", "/api/v1/settings/retention", `{"default_days":1.5}`, "admin", 400},
		{"PUT", "/api/v1/settings/retention", `{"default_days":-1}`, "admin", 400},
		{"PUT", "/api/v1/catalog/tables/missing/retention", `{"retention_days":null}`, "member", 403},
		{"PUT", "/api/v1/catalog/tables/missing/retention", `{"retention_days":null}`, "admin", 404},
		{"PUT", "/api/v1/catalog/tables/missing/retention", `{}`, "admin", 400},
		{"PUT", "/api/v1/catalog/tables/missing/retention", `{"retention_days":"30"}`, "admin", 400},
		{"PUT", "/api/v1/catalog/tables/missing/retention", `{"retention_days":36501}`, "admin", 400},
	} {
		r := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		r = r.WithContext(shared.WithUser(context.Background(), shared.User{Role: test.role}))
		w := httptest.NewRecorder()
		s.API.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%s %s %s: %d %s", test.role, test.path, test.body, w.Code, w.Body)
		}
	}
}
