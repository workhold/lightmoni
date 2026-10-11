package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/storage"
)

func TestKeyTableGrantsLifecycle(t *testing.T) {
	a, server, client := testAuth(t)
	status, _ := authRequest(t, client, "POST", server.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatal(status)
	}
	for _, tables := range [][]string{nil, {}, {"*"}, {"log_web"}, {"Web"}, {"web", "../host"}, {strings.Repeat("a", 49)}} {
		status, _ := authRequest(t, client, "POST", server.URL+"/api/v1/keys", map[string]any{"name": "invalid", "allowed_tables": tables})
		if status != 400 {
			t.Fatalf("invalid grant %v: %d", tables, status)
		}
	}
	status, created := authRequest(t, client, "POST", server.URL+"/api/v1/keys", map[string]any{"name": "web", "allowed_tables": []string{"web", "app", "web"}})
	if status != 201 || !reflect.DeepEqual(created["allowed_tables"], []any{"app", "web"}) {
		t.Fatalf("create: %d %v", status, created)
	}
	id := created["id"].(string)
	for _, table := range []string{"app", "web"} {
		if err := a.AuthorizeTable(id, table); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"host", "web_extra", "log_web", "Web"} {
		if err := a.AuthorizeTable(id, table); !errors.Is(err, ErrTableNotAllowed) {
			t.Fatalf("unexpected permission for %s: %v", table, err)
		}
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"allowed_tables": []string{"mobile"}})
	if status != 200 || a.AuthorizeTable(id, "mobile") != nil || !errors.Is(a.AuthorizeTable(id, "web"), ErrTableNotAllowed) {
		t.Fatalf("permission update: %d", status)
	}
	for _, tables := range [][]string{{}, {"*"}, {"metric_web_sum"}} {
		status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"allowed_tables": tables})
		if status != 400 || a.AuthorizeTable(id, "mobile") != nil {
			t.Fatal("invalid update changed grants")
		}
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"active": false})
	if status != 200 || !errors.Is(a.AuthorizeTable(id, "mobile"), ErrTableNotAllowed) {
		t.Fatal("disabled key allowed")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"active": true})
	if status != 200 || a.AuthorizeTable(id, "mobile") != nil {
		t.Fatal("toggle lost grants")
	}
	response, err := client.Get(server.URL + "/api/v1/keys")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var list []keyItem
	if json.NewDecoder(response.Body).Decode(&list) != nil || len(list) != 1 || !reflect.DeepEqual(list[0].AllowedTables, []string{"mobile"}) {
		t.Fatalf("readback: %+v", list)
	}
	request := httptest.NewRequest("POST", "/v1/logs", nil)
	request.Header.Set("Authorization", "Bearer "+created["key"].(string))
	if validID, err := a.ValidateKey(request); err != nil || validID != id {
		t.Fatal("editing grants rotated the secret")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/missing", map[string]any{"allowed_tables": []string{"web"}})
	if status != http.StatusNotFound {
		t.Fatal("missing key update accepted")
	}
	_, _ = a.DB.Exec("UPDATE ingest_keys SET allowed_tables_json='not JSON' WHERE id=?", id)
	if !errors.Is(a.AuthorizeTable(id, "mobile"), ErrTableNotAllowed) {
		t.Fatal("corrupt grants failed open")
	}
}

func TestLegacyKeysRequireExplicitTableGrants(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(filepath.Join(dir, "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE ingest_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,last_used TEXT,upload_batches INTEGER NOT NULL DEFAULT 0,error_count INTEGER NOT NULL DEFAULT 0)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec("INSERT INTO ingest_keys(id,name,token_hash,created_at) VALUES('legacy','legacy',?,'2026-10-10')", hash("legacy-secret"))
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(db, dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(db, dir, "http://localhost"); err != nil {
		t.Fatal("migration is not idempotent", err)
	}
	request := httptest.NewRequest("POST", "/v1/logs", nil)
	request.Header.Set("Authorization", "Bearer legacy-secret")
	if id, err := a.ValidateKey(request); err != nil || id != "legacy" {
		t.Fatal("migration changed secret")
	}
	if !errors.Is(a.AuthorizeTable("legacy", "web"), ErrTableNotAllowed) {
		t.Fatal("legacy key retained unrestricted write access")
	}
	_, err = db.Exec(`UPDATE ingest_keys SET allowed_tables_json='["web"]' WHERE id='legacy'`)
	if err != nil {
		t.Fatal(err)
	}
	// Reopen the database and auth service to verify persistent grants.
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := storage.Open(filepath.Join(dir, "legacy.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	a, err = New(reopened, dir, "http://localhost")
	if err != nil || a.AuthorizeTable("legacy", "web") != nil || !errors.Is(a.AuthorizeTable("legacy", "host"), ErrTableNotAllowed) {
		t.Fatal("persistent grants were lost", err)
	}
}

func TestExplicitAllTableKeyLifecycle(t *testing.T) {
	a, server, client := testAuth(t)
	status, _ := authRequest(t, client, "POST", server.URL+"/api/v1/setup", map[string]string{"name": "admin", "password": "password123"})
	if status != 201 {
		t.Fatal(status)
	}
	status, created := authRequest(t, client, "POST", server.URL+"/api/v1/keys", map[string]any{"name": "all tables", "allow_all_tables": true})
	if status != 201 || created["allow_all_tables"] != true || !reflect.DeepEqual(created["allowed_tables"], []any{}) {
		t.Fatalf("create all-table key: %d %v", status, created)
	}
	id := created["id"].(string)
	for _, table := range []string{"web", "host", "probe", "future_business"} {
		if err := a.AuthorizeTable(id, table); err != nil {
			t.Fatalf("all-table key rejected %s: %v", table, err)
		}
	}
	for _, table := range []string{"*", "log_web", "../private", "Web"} {
		if !errors.Is(a.AuthorizeTable(id, table), ErrTableNotAllowed) {
			t.Fatalf("all-table key accepted invalid name %q", table)
		}
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"allow_all_tables": false})
	if status != 400 || a.AuthorizeTable(id, "host") != nil {
		t.Fatal("switching to an empty whitelist changed permissions")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"allow_all_tables": false, "allowed_tables": []string{"web"}})
	if status != 200 || a.AuthorizeTable(id, "web") != nil || !errors.Is(a.AuthorizeTable(id, "host"), ErrTableNotAllowed) {
		t.Fatal("switching to whitelist did not revoke all-table access")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"allow_all_tables": true})
	if status != 200 || a.AuthorizeTable(id, "future_business") != nil {
		t.Fatal("switching back to all tables failed")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"active": false})
	if status != 200 || !errors.Is(a.AuthorizeTable(id, "web"), ErrTableNotAllowed) {
		t.Fatal("disabled all-table key accepted")
	}
	status, _ = authRequest(t, client, "PUT", server.URL+"/api/v1/keys/"+id, map[string]any{"active": true, "name": "renamed all tables"})
	if status != 200 || a.AuthorizeTable(id, "host") != nil {
		t.Fatal("toggle or rename lost all-table permission")
	}
	response, err := client.Get(server.URL + "/api/v1/keys")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var list []keyItem
	if err = json.NewDecoder(response.Body).Decode(&list); err != nil || len(list) != 1 || !list[0].AllowAllTables || len(list[0].AllowedTables) != 0 {
		t.Fatalf("all-table readback: %+v %v", list, err)
	}
	var databaseFile string
	if err := a.DB.QueryRow("SELECT file FROM pragma_database_list WHERE name='main'").Scan(&databaseFile); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(a.DB, filepath.Dir(databaseFile), "http://localhost")
	if err != nil || restarted.AuthorizeTable(id, "future_business") != nil {
		t.Fatal("restart lost all-table permission", err)
	}
}

func TestWhitelistMigrationDoesNotGrantAllTables(t *testing.T) {
	a, _, _ := testAuth(t)
	_, err := a.DB.Exec(`INSERT INTO ingest_keys(id,name,token_hash,created_at,allowed_tables_json) VALUES('scoped','scoped',?,'2026-10-11','["web"]')`, hash("scoped-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.DB.Exec("ALTER TABLE ingest_keys DROP COLUMN allow_all_tables"); err != nil {
		t.Fatal(err)
	}
	if err = migrateKeyTables(a.DB); err != nil {
		t.Fatal(err)
	}
	if a.AuthorizeTable("scoped", "web") != nil || !errors.Is(a.AuthorizeTable("scoped", "host"), ErrTableNotAllowed) {
		t.Fatal("migration changed an existing whitelist")
	}
}
