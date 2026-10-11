package ingest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/storage"
)

func retentionCatalog(t *testing.T, fail func(string) bool) (*Catalog, *[]string) {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "retention.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	queries := []string{}
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		queries = append(queries, query)
		if fail != nil && fail(query) {
			http.Error(w, "DDL rejected", 503)
			return
		}
		if strings.Contains(query, "system.columns") {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{}})
		}
	}))
	t.Cleanup(chServer.Close)
	ch := storage.NewClickHouse(chServer.URL, "writer", "fixture")
	catalog, err := NewCatalog(db, ch, ch)
	if err != nil {
		t.Fatal(err)
	}
	return catalog, &queries
}

func addRetentionTable(t *testing.T, c *Catalog, name, kind, subtype string, days *int) {
	t.Helper()
	public := kind + "_" + name
	if subtype != "" {
		public += "_" + subtype
	}
	_, err := c.DB.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,retention_days) VALUES(?,?,?,?,?,'[]',?)", public, public, name, kind, subtype, days)
	if err != nil {
		t.Fatal(err)
	}
}

func TestRetentionInheritanceAndPersistence(t *testing.T) {
	ctx := context.Background()
	c, queries := retentionCatalog(t, nil)
	custom, forever := 30, 0
	addRetentionTable(t, c, "a", "log", "", nil)
	addRetentionTable(t, c, "b", "metric", "gauge", &custom)
	addRetentionTable(t, c, "c", "trace", "", &forever)
	if err := c.SetDefaultRetention(ctx, 14); err != nil {
		t.Fatal(err)
	}
	if len(*queries) != 1 || !strings.Contains((*queries)[0], "_lm_log_a MODIFY TTL event_time + INTERVAL 14 DAY") {
		t.Fatalf("default must only update inheriting tables: %v", *queries)
	}
	if err := c.SetTableRetention(ctx, "metric_b_gauge", nil); err != nil {
		t.Fatal(err)
	}
	if err := c.SetTableRetention(ctx, "log_a", &forever); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*queries)[len(*queries)-1], "REMOVE TTL") {
		t.Fatal("forever must remove TTL")
	}
	reopened, err := NewCatalog(c.DB, c.CH, c.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tables, err := reopened.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(tables) != 3 || tables[0].RetentionDays == nil || *tables[0].RetentionDays != 0 || tables[0].EffectiveRetentionDays != 0 || tables[1].RetentionDays != nil || tables[1].EffectiveRetentionDays != 14 || tables[2].EffectiveRetentionDays != 0 {
		t.Fatalf("read after reopen: %+v", tables)
	}
	if _, err = c.Ensure(ctx, "metric", "new", "sum", "app"); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, query := range *queries {
		if strings.HasPrefix(query, "CREATE TABLE IF NOT EXISTS _lm_metric_new_sum") {
			found = strings.Contains(query, "INTERVAL 14 DAY")
		}
	}
	if !found {
		t.Fatalf("new metrics must use global default: %v", *queries)
	}
	if err := c.SetDefaultRetention(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = c.Ensure(ctx, "log", "forever", "", "app"); err != nil {
		t.Fatal(err)
	}
	for _, query := range *queries {
		if strings.HasPrefix(query, "CREATE TABLE IF NOT EXISTS _lm_log_forever") && strings.Contains(query, " TTL ") {
			t.Fatal("new forever table has TTL")
		}
	}
}

func TestRetentionFailureRestoresAttemptedTables(t *testing.T) {
	c, queries := retentionCatalog(t, func(query string) bool {
		return strings.Contains(query, "_lm_log_b MODIFY TTL") && strings.Contains(query, "14 DAY")
	})
	addRetentionTable(t, c, "a", "log", "", nil)
	addRetentionTable(t, c, "b", "log", "", nil)
	if err := c.SetDefaultRetention(context.Background(), 14); err == nil {
		t.Fatal("accepted failed DDL")
	}
	days, _ := c.DefaultRetention(context.Background())
	if days != 7 {
		t.Fatal("persisted failed default")
	}
	if len(*queries) != 4 || !strings.Contains((*queries)[2], "_lm_log_a MODIFY TTL event_time + INTERVAL 7 DAY") || !strings.Contains((*queries)[3], "_lm_log_b MODIFY TTL event_time + INTERVAL 7 DAY") {
		t.Fatalf("missing compensation: %v", *queries)
	}
	*queries = nil
	days = 14
	if err := c.SetTableRetention(context.Background(), "log_b", &days); err == nil {
		t.Fatal("accepted failed table DDL")
	}
	list, _ := c.List(context.Background())
	if list[1].RetentionDays != nil || list[1].EffectiveRetentionDays != 7 {
		t.Fatal("persisted failed override")
	}
	if len(*queries) != 2 || !strings.Contains((*queries)[1], "7 DAY") {
		t.Fatal("did not restore ambiguous failed table DDL")
	}
	before := len(*queries)
	for _, invalid := range []int{-1, 36501} {
		if !errors.Is(c.SetTableRetention(context.Background(), "log_a", &invalid), ErrInvalidRetention) {
			t.Fatal("invalid override accepted")
		}
		if !errors.Is(c.SetDefaultRetention(context.Background(), invalid), ErrInvalidRetention) {
			t.Fatal("invalid default accepted")
		}
	}
	if !errors.Is(c.SetTableRetention(context.Background(), "missing", nil), sql.ErrNoRows) || len(*queries) != before {
		t.Fatal("invalid request executed DDL")
	}
}

func TestRetentionMigrationPreservesLegacyDurations(t *testing.T) {
	c, _ := retentionCatalog(t, nil)
	if _, err := c.DB.Exec("ALTER TABLE catalog DROP COLUMN retention_days"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"log", "metric", "trace"} {
		_, err := c.DB.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json) VALUES(?,?,'legacy',?,'','[]')", kind, kind, kind)
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := NewCatalog(c.DB, c.CH, c.Reader); err != nil {
		t.Fatal(err)
	}
	list, err := c.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range list {
		want := 7
		if table.Kind == "metric" {
			want = 30
		}
		if table.EffectiveRetentionDays != want {
			t.Fatalf("legacy %s changed: %+v", table.Kind, table)
		}
	}
}
