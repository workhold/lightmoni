package ingest

import (
	"context"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/shared"
	"strings"
)

func viewQuery(kind, subtype, table string) string {
	if kind == "metric" && (subtype == "sum" || subtype == "gauge") {
		return "SELECT * EXCEPT(value),value_float AS value FROM " + table + " FINAL"
	}
	return "SELECT * FROM " + table + " FINAL"
}
func (c *Catalog) refreshColumns(ctx context.Context, public string) error {
	result, e := c.CH.Query(ctx, "SELECT name,type FROM system.columns WHERE database='lightmoni' AND table={table:String} ORDER BY position", map[string]string{"table": public})
	if e != nil {
		return e
	}
	cols := []shared.Column{}
	for _, row := range result.Data {
		cols = append(cols, shared.Column{Name: fmt.Sprint(row["name"]), Type: fmt.Sprint(row["type"])})
	}
	_, e = c.DB.ExecContext(ctx, "UPDATE catalog SET columns_json=? WHERE name=?", jsonText(cols), public)
	return e
}

// Preserve existing integer values; old doubles already rounded by earlier
// prototypes cannot be reconstructed. New records carry both exact int64 and
// original float64, while public value remains convenient for float queries.
func (c *Catalog) Migrate(ctx context.Context) error {
	tables, e := c.List(ctx)
	if e != nil {
		return e
	}
	for _, table := range tables {
		if table.Kind != "metric" || (table.MetricType != "sum" && table.MetricType != "gauge") {
			continue
		}
		if !ValidTable(table.LogicalName) || table.Name != "metric_"+table.LogicalName+"_"+table.MetricType {
			return fmt.Errorf("invalid catalog table during migration")
		}
		raw := "_lm_" + table.Name
		if e = c.CH.Exec(ctx, "ALTER TABLE "+raw+" ADD COLUMN IF NOT EXISTS value_int Nullable(Int64) DEFAULT if(value_type='int',toInt64(value),NULL), ADD COLUMN IF NOT EXISTS value_float Float64 DEFAULT toFloat64(value)"); e != nil {
			return e
		}
		owner := strings.ReplaceAll(c.CH.User, "`", "``")
		if e = c.CH.Exec(ctx, "CREATE OR REPLACE VIEW "+table.Name+" DEFINER=`"+owner+"` SQL SECURITY DEFINER AS "+viewQuery(table.Kind, table.MetricType, raw)); e != nil {
			return e
		}
		if e = c.refreshColumns(ctx, table.Name); e != nil {
			return e
		}
	}
	return nil
}
