package logs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/lightmoni/lightmoni/internal/shared"
)

type Filter struct {
	Scope    string `json:"scope"`
	Field    string `json:"field"`
	Type     string `json:"type"`
	Op       string `json:"op"`
	Value    any    `json:"value,omitempty"`
	Disabled bool   `json:"disabled,omitempty"`
}
type Spec struct {
	TableID    string                      `json:"table_id"`
	IntervalMS int64                       `json:"interval_ms,omitempty"`
	Range      shared.Range                `json:"range"`
	Services   []string                    `json:"services,omitempty"`
	Keyword    string                      `json:"keyword,omitempty"`
	Filters    []Filter                    `json:"filters,omitempty"`
	Sort       string                      `json:"sort,omitempty"`
	Mode       string                      `json:"mode,omitempty"`
	SQL        string                      `json:"sql,omitempty"`
	Params     map[string]shared.Parameter `json:"params,omitempty"`
}

var safeName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,80}$`)

func validateRange(r shared.Range) error {
	from, e := time.Parse(time.RFC3339Nano, r.From)
	if e != nil {
		return errors.New("开始时间必须是带时区的 UTC/RFC3339 时间")
	}
	to, e := time.Parse(time.RFC3339Nano, r.To)
	if e != nil || !to.After(from) {
		return errors.New("结束时间必须晚于开始时间")
	}
	if to.Sub(from) > 31*24*time.Hour {
		return errors.New("单次日志查询最多 31 天，请缩小时间范围")
	}
	return nil
}
func (m *Module) table(ctx context.Context, id string) (shared.Table, error) {
	tables, e := m.deps.Catalog(ctx)
	if e != nil {
		return shared.Table{}, e
	}
	for _, t := range tables {
		if t.ID == id && t.Kind == "log" && safeName.MatchString(t.Name) {
			return t, nil
		}
	}
	return shared.Table{}, errors.New("日志表不在目录中")
}
func (m *Module) compile(ctx context.Context, s Spec) (string, map[string]shared.Parameter, shared.Table, error) {
	if e := validateRange(s.Range); e != nil {
		return "", nil, shared.Table{}, e
	}
	if _, err := selectedInterval(s); err != nil {
		return "", nil, shared.Table{}, err
	}
	t, e := m.table(ctx, s.TableID)
	if e != nil {
		return "", nil, t, e
	}
	if len(s.Filters) > 30 || len(s.Services) > 64 || len(s.Keyword) > 1024 || len(s.SQL) > 32768 {
		return "", nil, t, errors.New("查询条件超过限制")
	}
	if s.Sort != "" && s.Sort != "asc" && s.Sort != "desc" {
		return "", nil, t, errors.New("不支持的排序方向")
	}
	params := map[string]shared.Parameter{}
	base := t.Name
	if s.Mode == "sql" {
		if strings.TrimSpace(s.SQL) == "" || m.deps.ReferencedTables == nil {
			return "", nil, t, errors.New("SQL 模式需要只读 SELECT 查询")
		}
		refs, err := m.deps.ReferencedTables(ctx, s.SQL)
		if err != nil {
			return "", nil, t, err
		}
		if len(refs) != 1 || refs[0] != t.Name {
			return "", nil, t, errors.New("日志 SQL 必须且只能引用当前日志表")
		}
		base = "(" + s.SQL + ")"
		for k, v := range s.Params {
			if strings.HasPrefix(k, "lm_log_") {
				return "", nil, t, errors.New("SQL 参数名使用了保留前缀")
			}
			params[k] = v
		}
	} else if s.Mode != "" && s.Mode != "filters" {
		return "", nil, t, errors.New("未知检索模式")
	}
	where := []string{"$__timeFilter(event_time)"}
	if len(s.Services) > 0 {
		params["lm_log_services"] = shared.Parameter{Type: "Array(String)", Value: s.Services}
		where = append(where, "service IN {lm_log_services:Array(String)}")
	}
	if s.Keyword != "" {
		params["lm_log_keyword"] = shared.Parameter{Type: "String", Value: s.Keyword}
		where = append(where, "positionCaseInsensitiveUTF8(body,{lm_log_keyword:String})>0")
	}
	columns := map[string]string{}
	for _, c := range t.Columns {
		columns[c.Name] = c.Type
	}
	for i, f := range s.Filters {
		if f.Disabled {
			continue
		}
		prefix := fmt.Sprintf("lm_log_%d", i)
		key := prefix + "_key"
		value := prefix + "_value"
		expr, exists := "", "1"
		typ := f.Type
		if typ == "" {
			typ = "string"
		}
		if f.Scope == "attribute" {
			if f.Field == "" || len(f.Field) > 256 {
				return "", nil, t, errors.New("属性名称无效")
			}
			params[key] = shared.Parameter{Type: "String", Value: f.Field}
			exists = "JSONHas(attributes_json,{" + key + ":String})"
			switch typ {
			case "string":
				expr = "attributes[{" + key + ":String}]"
				exists += " AND JSONType(attributes_json,{" + key + ":String})='String'"
			case "number":
				expr = "toFloat64OrNull(JSONExtractRaw(attributes_json,{" + key + ":String}))"
				exists += " AND JSONType(attributes_json,{" + key + ":String}) IN ('Int64','UInt64','Float64')"
			case "boolean":
				expr = "JSONExtractBool(attributes_json,{" + key + ":String})"
				exists += " AND JSONType(attributes_json,{" + key + ":String})='Bool'"
			default:
				return "", nil, t, errors.New("属性过滤只支持字符串、数字和布尔值")
			}
			// Presence is independent from the selected value type.
			if f.Op == "exists" || f.Op == "not_exists" {
				exists = "JSONHas(attributes_json,{" + key + ":String})"
			}
		} else if f.Scope == "column" || f.Scope == "" {
			columnType, ok := columns[f.Field]
			if !ok || !safeName.MatchString(f.Field) {
				return "", nil, t, errors.New("字段不在当前表目录中")
			}
			if strings.Contains(columnType, "Map") || strings.Contains(columnType, "Array") {
				return "", nil, t, errors.New("复合字段请使用属性过滤")
			}
			expr = "`" + f.Field + "`"
			exists = "isNotNull(" + expr + ")"
			if strings.Contains(columnType, "String") && typ != "string" {
				return "", nil, t, errors.New("字符串字段不能使用数字/布尔过滤")
			}
		} else {
			return "", nil, t, errors.New("未知字段范围")
		}
		if f.Op == "exists" {
			where = append(where, "("+exists+")")
			continue
		}
		if f.Op == "not_exists" {
			where = append(where, "NOT ("+exists+")")
			continue
		}
		op := map[string]string{"eq": "=", "ne": "!=", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[f.Op]
		if f.Op == "in" || f.Op == "not_in" {
			if typ != "string" {
				return "", nil, t, errors.New("多值过滤使用字符串列表")
			}
			values, err := stringsValue(f.Value)
			if err != nil {
				return "", nil, t, err
			}
			params[value] = shared.Parameter{Type: "Array(String)", Value: values}
			op = "IN"
			if f.Op == "not_in" {
				op = "NOT IN"
			}
			where = append(where, "("+exists+" AND "+expr+" "+op+" {"+value+":Array(String)})")
			continue
		}
		if op == "" {
			return "", nil, t, errors.New("未知过滤运算符")
		}
		if typ != "number" && f.Op != "eq" && f.Op != "ne" {
			return "", nil, t, errors.New("范围比较只支持数字字段")
		}
		p := shared.Parameter{}
		switch typ {
		case "string":
			v, ok := f.Value.(string)
			if !ok || len(v) > 4096 {
				return "", nil, t, errors.New("过滤值必须是字符串")
			}
			p = shared.Parameter{Type: "String", Value: v}
		case "number":
			literal := fmt.Sprint(f.Value)
			n, err := strconv.ParseFloat(literal, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return "", nil, t, errors.New("过滤值必须是有限数值")
			}
			p = shared.Parameter{Type: "Float64", Value: n}
			if f.Scope == "attribute" && regexp.MustCompile(`^-?[0-9]{1,29}$`).MatchString(literal) {
				// JSON integer attributes must not be rounded through Float64.
				expr = "toDecimal128OrNull(JSONExtractRaw(attributes_json,{" + key + ":String}),9)"
				p = shared.Parameter{Type: "Decimal(38,9)", Value: literal}
			} else if (f.Scope == "column" || f.Scope == "") && strings.Contains(columns[f.Field], "UInt") {
				if _, err := strconv.ParseUint(literal, 10, 64); err != nil {
					return "", nil, t, errors.New("无符号整数字段需要精确的 UInt64 值")
				}
				p = shared.Parameter{Type: "UInt64", Value: literal}
			} else if (f.Scope == "column" || f.Scope == "") && strings.Contains(columns[f.Field], "Int") {
				if _, err := strconv.ParseInt(literal, 10, 64); err != nil {
					return "", nil, t, errors.New("整数字段需要精确的 Int64 值")
				}
				p = shared.Parameter{Type: "Int64", Value: literal}
			}
		case "boolean":
			v, ok := f.Value.(bool)
			if !ok {
				return "", nil, t, errors.New("过滤值必须是布尔值")
			}
			p = shared.Parameter{Type: "Bool", Value: v}
		default:
			return "", nil, t, errors.New("未知过滤值类型")
		}
		params[value] = p
		where = append(where, "("+exists+" AND "+expr+op+"{"+value+":"+p.Type+"})")
	}
	return "SELECT * FROM " + base + " WHERE " + strings.Join(where, " AND "), params, t, nil
}
func stringsValue(v any) ([]string, error) {
	values := []string{}
	switch a := v.(type) {
	case []string:
		values = a
	case []any:
		for _, v := range a {
			s, ok := v.(string)
			if !ok {
				return nil, errors.New("多值过滤必须是字符串列表")
			}
			values = append(values, s)
		}
	default:
		return nil, errors.New("多值过滤必须是字符串列表")
	}
	if len(values) == 0 || len(values) > 64 {
		return nil, errors.New("多值过滤需要 1–64 个值")
	}
	return values, nil
}
func (m *Module) execute(ctx context.Context, s Spec, queries []shared.Query) ([]shared.QueryResult, error) {
	bucket, err := selectedInterval(s)
	if err != nil {
		return nil, err
	}
	response, e := m.deps.Query(ctx, shared.QueryRequest{RequestID: newID(), Range: s.Range, IntervalMS: bucket, Queries: queries, Source: "logs"})
	if e != nil {
		return nil, e
	}
	if len(response.Results) != len(queries) {
		return nil, errors.New("查询结果缺少响应")
	}
	for _, r := range response.Results {
		if r.Status == "error" || r.Status == "cancelled" {
			return nil, fmt.Errorf("查询 %s: %s", r.RefID, r.Error)
		}
	}
	return response.Results, nil
}
func interval(r shared.Range) int64 {
	from, _ := time.Parse(time.RFC3339Nano, r.From)
	to, _ := time.Parse(time.RFC3339Nano, r.To)
	return max(1000, to.Sub(from).Milliseconds()/80)
}
func rowObject(f shared.Frame, row []any) map[string]any {
	obj := map[string]any{}
	for i, c := range f.Columns {
		if i < len(row) {
			obj[c.Name] = row[i]
		}
	}
	return obj
}
func rawSpec(s Spec) string { b, _ := json.Marshal(s); return string(b) }

func selectedInterval(s Spec) (int64, error) {
	if s.IntervalMS == 0 {
		return interval(s.Range), nil
	}
	allowed := map[int64]bool{1000: true, 10000: true, 30000: true, 60000: true, 300000: true, 900000: true, 3600000: true, 86400000: true}
	if !allowed[s.IntervalMS] {
		return 0, errors.New("不支持的时间桶宽度")
	}
	from, _ := time.Parse(time.RFC3339Nano, s.Range.From)
	to, _ := time.Parse(time.RFC3339Nano, s.Range.To)
	if float64(to.Sub(from).Milliseconds())/float64(s.IntervalMS) > 2000 {
		return 0, errors.New("当前范围超过 2,000 个时间桶，请增大桶宽或缩小时间范围")
	}
	return s.IntervalMS, nil
}
