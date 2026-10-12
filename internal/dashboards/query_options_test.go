package dashboards

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestQueryOptionsPersistAcrossSaveCopyAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dashboards.db")
	db, mux := testModule(t, path)
	d := sample()
	d.Panels[0].Options["query_interval"] = "1min"
	d.Panels[0].Options["query_min_interval"] = "30s"
	d.Panels[0].Options["query_max_points"] = 120
	d.Panels[0].Queries[0].SQL = "SELECT $__timeInterval(event_time) AS time, quantileExact(0.95)(value) AS value FROM metric_host_gauge WHERE $__timeFilter(event_time) GROUP BY time ORDER BY time"
	code, saved := request(t, mux, "POST", "/api/v1/dashboards", d)
	if code != 201 {
		t.Fatalf("create: %d", code)
	}
	saved.Panels[0].Options["query_interval"] = "5m"
	code, saved = request(t, mux, "PUT", "/api/v1/dashboards/"+saved.ID, saved)
	if code != 200 {
		t.Fatalf("update: %d", code)
	}
	code, copy := request(t, mux, "POST", "/api/v1/dashboards/"+saved.ID+"/copy", map[string]string{"title": "聚合副本"})
	if code != 201 {
		t.Fatalf("copy: %d", code)
	}
	db.Close()
	db, mux = testModule(t, path)
	defer db.Close()
	for _, id := range []string{saved.ID, copy.ID} {
		code, read := request(t, mux, "GET", "/api/v1/dashboards/"+id, nil)
		opts := read.Panels[0].Options
		if code != 200 || opts["query_interval"] != "5m" || opts["query_min_interval"] != "30s" || opts["query_max_points"] != float64(120) || read.Panels[0].Queries[0].SQL != d.Panels[0].Queries[0].SQL {
			t.Fatalf("readback: %d %#v", code, read)
		}
	}
}

func TestInvalidQueryOptionsCannotBeSaved(t *testing.T) {
	db, mux := testModule(t, filepath.Join(t.TempDir(), "dashboards.db"))
	defer db.Close()
	for _, invalid := range []map[string]any{
		{"query_interval": "0s"}, {"query_interval": "1.5m"}, {"query_interval": "366d"}, {"query_interval": "999999999999999999999d"}, {"query_interval": 60},
		{"query_min_interval": "bad"}, {"query_max_points": 0}, {"query_max_points": 10001}, {"query_max_points": 1.5}, {"query_max_points": "10"}, {"query_max_points": nil},
	} {
		d := sample()
		d.Panels[0].Options = invalid
		if code, _ := request(t, mux, "POST", "/api/v1/dashboards", d); code != 400 {
			t.Errorf("accepted invalid options: %#v (%d)", invalid, code)
		}
	}
	for _, valid := range []map[string]any{{}, {"query_interval": "auto"}, {"query_interval": " 5min "}, {"query_min_interval": "", "query_max_points": json.Number("100")}} {
		if err := validateQueryOptions(valid); err != nil {
			t.Errorf("rejected valid options: %#v: %v", valid, err)
		}
	}
}
