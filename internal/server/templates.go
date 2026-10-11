package server

import (
	"github.com/lightmoni/lightmoni/internal/shared"
	"net/http"
	"strings"
)

type Template struct {
	ID          string         `json:"id"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Type        string         `json:"type"`
	TableID     string         `json:"table_id"`
	SQL         string         `json:"sql"`
	Options     map[string]any `json:"options"`
}

func (s *Server) registerTemplates() {
	s.API.HandleFunc("GET /api/v1/templates", func(w http.ResponseWriter, r *http.Request) {
		tables, e := s.Catalog.List(r.Context())
		if e != nil {
			shared.Error(w, 500, e.Error())
			return
		}
		templates := []Template{}
		for _, t := range tables {
			var title, description, sql string
			chart := "line"
			switch t.Kind {
			case "log":
				title = "日志错误趋势"
				description = "按服务统计每个时间桶的ERROR及更高级别日志"
				sql = "SELECT $__timeInterval(event_time) AS time, service AS series, count() AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) AND severity_number >= 17 GROUP BY time,series ORDER BY time"
			case "metric":
				switch t.MetricType {
				case "sum":
					title = "业务计数趋势"
					description = "Delta指标按时间、服务和指标名称汇总"
					sql = "SELECT $__timeInterval(event_time) AS time, concat(service, ' / ', name) AS series, sum(toDecimal256(value_int,0)) AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) AND temporality='DELTA' GROUP BY time,series ORDER BY time"
				case "gauge":
					title = "机器与业务观测值"
					description = "按机器与指标显示时间桶平均观测值；可编辑筛选指标名"
					sql = "SELECT $__timeInterval(event_time) AS time, concat(host_id, ' / ', name) AS series, avg(value) AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) GROUP BY time,series ORDER BY time"
				case "histogram":
					title = "延迟分布平均值"
					description = "以sum/count计算加权平均；不能平均各实例分位数"
					sql = "SELECT $__timeInterval(event_time) AS time, concat(service, ' / ', name) AS series, sum(sum)/nullIf(sum(count),0) AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) AND temporality='DELTA' GROUP BY time,series ORDER BY time"
				}
			case "trace":
				title = "链路耗时趋势"
				description = "按服务显示调用平均毫秒耗时"
				sql = "SELECT $__timeInterval(start_time) AS time, service AS series, avg(duration_ns)/1000000 AS value FROM " + t.Name + " WHERE $__timeFilter(start_time) GROUP BY time,series ORDER BY time"
			}
			if sql != "" {
				templates = append(templates, Template{ID: t.ID + "-trend", Title: title, Description: description, Type: chart, TableID: t.ID, SQL: sql, Options: map[string]any{"x": "time", "y": "value", "series": "series"}})
			}
			if t.Kind == "log" {
				templates = append(templates, Template{ID: t.ID + "-levels", Title: "日志级别占比", Description: "查看查询范围内各级别日志数量", Type: "pie", TableID: t.ID, SQL: "SELECT severity AS category,count() AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) GROUP BY category ORDER BY value DESC", Options: map[string]any{"x": "category", "y": "value"}})
			}
			if t.Kind == "metric" && t.MetricType == "gauge" && strings.Contains(t.LogicalName, "host") {
				templates = append(templates, Template{ID: t.ID + "-cpu", Title: "主机 CPU", Description: "主机CPU利用率，0到1，可设百分比单位", Type: "line", TableID: t.ID, SQL: "SELECT $__timeInterval(event_time) AS time, host_id AS series, avg(value) AS value FROM " + t.Name + " WHERE $__timeFilter(event_time) AND name='host.cpu.utilization' GROUP BY time,series ORDER BY time", Options: map[string]any{"x": "time", "y": "value", "series": "series", "unit": "percentunit"}})
			}
		}
		shared.JSON(w, 200, templates)
	})
}
