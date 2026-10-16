package dashboards

import (
	"path/filepath"
	"testing"
)

func TestDashboardRowsSettingsPersistAndCopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dashboards.db")
	db, mux := testModule(t, path)
	d := sample()
	d.Panels[0].ID = "panel-a"
	d.Rows = []Row{{ID: "row-a", Title: "服务", PanelIDs: []string{"panel-a"}, Collapsed: true}}
	d.Tags = []string{"服务"}
	d.Links = []Link{{Title: "下钻", URL: "/dashboards/target", IncludeTime: true, IncludeVariables: true, NewTab: true}}
	d.Variables = []Variable{{Name: "service", Type: "text", Value: "api", Description: "服务名称", Hide: true, SkipURLSync: true}}
	d.Range.From = "now-1M/M"
	d.Range.To = "now/M"
	code, saved := request(t, mux, "POST", "/api/v1/dashboards", d)
	if code != 201 {
		t.Fatalf("create: %d", code)
	}
	code, copy := request(t, mux, "POST", "/api/v1/dashboards/"+saved.ID+"/copy", map[string]string{"title": "copy"})
	if code != 201 || copy.Panels[0].ID == saved.Panels[0].ID || copy.Rows[0].ID == saved.Rows[0].ID || copy.Rows[0].PanelIDs[0] != copy.Panels[0].ID {
		t.Fatalf("copy references: %d %#v", code, copy)
	}
	db.Close()
	db, mux = testModule(t, path)
	defer db.Close()
	for _, id := range []string{saved.ID, copy.ID} {
		code, read := request(t, mux, "GET", "/api/v1/dashboards/"+id, nil)
		if code != 200 || len(read.Rows) != 1 || !read.Rows[0].Collapsed || read.Tags[0] != "服务" || !read.Links[0].IncludeVariables || !read.Variables[0].SkipURLSync || !read.Variables[0].Hide || read.Range.From != "now-1M/M" {
			t.Fatalf("readback: %d %#v", code, read)
		}
	}
}
func TestDashboardRowsRejectDanglingAndDuplicateReferences(t *testing.T) {
	for _, rows := range [][]Row{{{ID: "r", Title: "服务", PanelIDs: []string{"missing"}}}, {{ID: "r", Title: "服务", PanelIDs: []string{"p", "p"}}}, {{ID: "r", Title: "服务", PanelIDs: []string{"p"}}, {ID: "s", Title: "机器", PanelIDs: []string{"p"}}}, {{ID: "r", Title: "服务"}, {ID: "r", Title: "机器"}}} {
		d := sample()
		d.Panels[0].ID = "p"
		d.Rows = rows
		if normalize(&d) == nil {
			t.Fatalf("accepted invalid rows: %#v", rows)
		}
	}
	for _, url := range []string{"javascript:alert(1)", "//example.com", "data:text/html,a"} {
		d := sample()
		d.Links = []Link{{Title: "unsafe", URL: url}}
		if normalize(&d) == nil {
			t.Fatalf("accepted URL %s", url)
		}
	}
}

func TestDashboardEpochRangeCanBeSaved(t *testing.T) {
	d := sample()
	d.Range.From = "1700000000000"
	d.Range.To = "1700003600"
	if err := normalize(&d); err != nil || d.Range.From != "2023-11-14T22:13:20Z" || d.Range.To != "2023-11-14T23:13:20Z" {
		t.Fatalf("epoch normalization: %#v %v", d.Range, err)
	}
}
