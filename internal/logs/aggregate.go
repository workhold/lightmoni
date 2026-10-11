package logs

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/lightmoni/lightmoni/internal/shared"
)

// Aggregations query the complete selected range independently of the bounded
// history cache. Values and JSON types remain separate to preserve typed filters.
func (m *Module) aggregate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Spec  Spec   `json:"spec"`
		Field string `json:"field"`
		Limit int    `json:"limit"`
	}
	if err := shared.Decode(r, &req); err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	base, params, table, err := m.compile(r.Context(), req.Spec)
	if err != nil {
		shared.Error(w, 400, err.Error())
		return
	}
	if req.Limit == 0 {
		req.Limit = 10
	}
	if req.Limit < 1 || req.Limit > 50 {
		shared.Error(w, 400, "Top 值数量需为 1–50")
		return
	}
	expr, present, kind := "", "1", "'String'"
	if strings.HasPrefix(req.Field, "attr:") {
		key := strings.TrimPrefix(req.Field, "attr:")
		if key == "" || len(key) > 256 {
			shared.Error(w, 400, "属性名称无效")
			return
		}
		params["lm_log_agg_field"] = shared.Parameter{Type: "String", Value: key}
		expr = "JSONExtractRaw(attributes_json,{lm_log_agg_field:String})"
		present = "JSONHas(attributes_json,{lm_log_agg_field:String})"
		kind = "toString(JSONType(attributes_json,{lm_log_agg_field:String}))"
	} else {
		for _, column := range table.Columns {
			if column.Name == req.Field && safeName.MatchString(column.Name) && !strings.Contains(column.Type, "Map") && !strings.Contains(column.Type, "Array") {
				expr = "toString(`" + column.Name + "`)"
				present = "isNotNull(`" + column.Name + "`)"
				if strings.Contains(column.Type, "Int") || strings.Contains(column.Type, "Float") || strings.Contains(column.Type, "Decimal") {
					kind = "'Number'"
				}
			}
		}
		if expr == "" {
			shared.Error(w, 400, "此字段不支持聚合")
			return
		}
	}
	groupSQL := fmt.Sprintf("SELECT %s AS value,%s AS value_type,count() AS count FROM (%s) WHERE %s GROUP BY value,value_type ORDER BY count DESC,value ASC LIMIT %d", expr, kind, base, present, req.Limit)
	countSQL := fmt.Sprintf("SELECT count() AS total,countIf(%s) AS present FROM (%s)", present, base)
	results, err := m.execute(r.Context(), req.Spec, []shared.Query{{RefID: "groups", SQL: groupSQL, Params: params}, {RefID: "totals", SQL: countSQL, Params: params}})
	if err != nil {
		shared.Error(w, 422, err.Error())
		return
	}
	if len(results[0].Frames) != 1 || len(results[1].Frames) != 1 {
		shared.Error(w, 502, "聚合没有返回标准数据框架")
		return
	}
	frame, truncated, _, err := freezeBudget(results[0].Frames[0], 1<<20, 50)
	if err != nil {
		shared.Error(w, 500, err.Error())
		return
	}
	// Do not round JSON integer values through float64: the UI converts value using
	// value_type and binds the original exact literal when drilling down.
	var total, presentCount any = "0", "0"
	if rows := results[1].Frames[0].Rows; len(rows) > 0 {
		obj := rowObject(results[1].Frames[0], rows[0])
		total = obj["total"]
		presentCount = obj["present"]
	}
	shared.JSON(w, 200, map[string]any{"frame": frame, "field": req.Field, "total": total, "present": presentCount, "truncated": truncated || results[0].Truncated, "generated_at": m.now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00"), "scope": "independent_complete_range_aggregation", "sql": groupSQL, "params": params, "range": req.Spec.Range})
}
