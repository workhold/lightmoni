package dashboards

import (
	"context"
	"github.com/lightmoni/lightmoni/internal/query"
	"github.com/lightmoni/lightmoni/internal/shared"
	"github.com/lightmoni/lightmoni/internal/storage"
	"path/filepath"
	"testing"
)

func TestSystemDashboardsSeedOnceAndRespectEditsAndDeletion(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "system.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	module, err := New(shared.Dependencies{DB: db})
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range SystemDashboards() {
		for _, p := range d.Panels {
			if _, err = query.ReferencedTables(p.Queries[0].SQL, map[string]bool{"metric_lightmoni_center_sum": true, "metric_lightmoni_center_gauge": true, "metric_lightmoni_center_histogram": true, "log_lightmoni_center": true, "metric_lightmoni_agent_gauge": true, "log_lightmoni_agent": true, "metric_lightmoni_sdk_gauge": true, "log_lightmoni_sdk": true}); err != nil {
				t.Fatalf("%s: %v", p.Title, err)
			}
		}
	}
	if err = module.SeedSystemDashboards(context.Background()); err != nil {
		t.Fatal(err)
	}
	db.Exec("UPDATE dashboards SET title='custom' WHERE id='system-center'")
	db.Exec("DELETE FROM dashboards WHERE id='system-sdk'")
	if err = module.SeedSystemDashboards(context.Background()); err != nil {
		t.Fatal(err)
	}
	var title string
	db.QueryRow("SELECT title FROM dashboards WHERE id='system-center'").Scan(&title)
	var count int
	db.QueryRow("SELECT count(*) FROM dashboards").Scan(&count)
	if title != "custom" || count != 2 {
		t.Fatal("seed overwrote user configuration or recreated deletion", title, count)
	}
}
