package dashboards

import (
	"context"
	"encoding/json"
	"github.com/lightmoni/lightmoni/internal/shared"
	"strings"
	"time"
)

func systemPanel(id, title, kind, sql string, index int) Panel {
	options := map[string]any{"x": "time", "y": "value", "series": "series"}
	if kind == "stat" {
		options = map[string]any{"y": "value", "decimals": 0}
	}
	if strings.Contains(title, "QPS") {
		options["decimals"] = 2
	}
	if kind == "bar" {
		options = map[string]any{"x": "category", "y": "value"}
	}
	return Panel{ID: id, Title: title, Type: kind, Queries: []Query{{RefID: "A", SQL: sql}}, Options: options, Grid: Grid{X: (index % 2) * 6, Y: (index / 2) * 6, W: 6, H: 6}}
}

func SystemDashboards() []Dashboard {
	center := Dashboard{ID: "system-center", Title: "系统监控 · 上报中心", Description: "内置自监控：上报接口 QPS、持久化接收量、错误、耗时、运行状态和系统日志。QPS 按最近一分钟平均；接收量只统计首次确认成功的批次，不重复计算补传。", Range: shared.Range{From: "now-1h", To: "now"}, Refresh: 10}
	agent := Dashboard{ID: "system-agent", Title: "系统监控 · 执行节点", Description: "按最近心跳统计在线执行节点，默认 90 秒超时（或控制周期的三倍）。LightMoni Agent 停止后在线数会降至零；支持在图表设置中配置低于预期在线数等告警。", Range: shared.Range{From: "now-1h", To: "now"}, Refresh: 10}
	sdk := Dashboard{ID: "system-sdk", Title: "系统监控 · SDK", Description: "业务 SDK 每 30 秒报告进程实例心跳、缓冲与诊断。90 秒无心跳视为离线；PHP 在请求结束或定时 flush 时上报。内部数据单独入表，不需要增加业务 Key 的 table 权限。", Range: shared.Range{From: "now-1h", To: "now"}, Refresh: 10}
	entries := []struct {
		d                *Dashboard
		title, kind, sql string
	}{
		{&center, "上报接口 QPS（最近一分钟）", "stat", "SELECT coalesce(sum(value_float),0)/60 AS value FROM metric_lightmoni_center_sum WHERE name='lightmoni.center.ingest_requests' AND event_time>=now()-INTERVAL 1 MINUTE"},
		{&center, "最近一分钟接收记录数", "stat", "SELECT coalesce(sum(value_float),0) AS value FROM metric_lightmoni_center_sum WHERE name='lightmoni.center.received_records' AND event_time>=now()-INTERVAL 1 MINUTE"},
		{&center, "接口 QPS · 按响应状态", "line", "SELECT toStartOfMinute(event_time) AS time,concat(attributes['signal'],' / ',attributes['status']) AS series,sum(value_float)/60 AS value FROM metric_lightmoni_center_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.ingest_requests' GROUP BY time,series ORDER BY time"},
		{&center, "接收记录数 · 每分钟", "line", "SELECT toStartOfMinute(event_time) AS time,attributes['signal'] AS series,sum(value_float) AS value FROM metric_lightmoni_center_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.received_records' GROUP BY time,series ORDER BY time"},
		{&center, "接收字节数 · 每分钟", "line", "SELECT toStartOfMinute(event_time) AS time,attributes['signal'] AS series,sum(value_float) AS value FROM metric_lightmoni_center_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.received_bytes' GROUP BY time,series ORDER BY time"},
		{&center, "上报请求平均耗时（毫秒）", "line", "SELECT $__timeInterval(event_time) AS time,attributes['signal'] AS series,sum(sum)/nullIf(sum(count),0) AS value FROM metric_lightmoni_center_histogram WHERE $__timeFilter(event_time) AND name='lightmoni.center.ingest_duration' GROUP BY time,series ORDER BY time"},
		{&center, "在线中心实例数", "stat", "SELECT uniqExact(instance_id) AS value FROM metric_lightmoni_center_gauge WHERE name='lightmoni.center.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND"},
		{&center, "上报失败数（最近一分钟）", "stat", "SELECT coalesce(sum(value_float),0) AS value FROM metric_lightmoni_center_sum WHERE name='lightmoni.center.ingest_requests' AND attributes['status']!='200' AND event_time>=now()-INTERVAL 1 MINUTE"},
		{&center, "中心运行状态", "line", "SELECT $__timeInterval(event_time) AS time,name AS series,max(value_float) AS value FROM metric_lightmoni_center_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.center.pending_batches','lightmoni.center.dropped_records') GROUP BY time,series ORDER BY time"},
		{&center, "堆内存（字节）", "line", "SELECT $__timeInterval(event_time) AS time,instance_id AS series,max(value_float) AS value FROM metric_lightmoni_center_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.center.heap_bytes' GROUP BY time,series ORDER BY time"},
		{&center, "运行协程数", "line", "SELECT $__timeInterval(event_time) AS time,instance_id AS series,max(value_float) AS value FROM metric_lightmoni_center_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.center.goroutines' GROUP BY time,series ORDER BY time"},
		{&center, "中心运行日志", "table", "SELECT event_time,severity,body FROM log_lightmoni_center WHERE $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100"},
		{&agent, "在线执行节点数", "stat", "SELECT uniqExact(agent_id) AS value FROM metric_lightmoni_agent_gauge WHERE name='lightmoni.agent.heartbeat' AND event_time+toIntervalSecond(greatest(90,toUInt32OrZero(attributes['heartbeat_timeout_seconds'])))>=now()"},
		{&agent, "在线执行节点 · 按节点", "bar", "SELECT agent_id AS category,agent_id FROM metric_lightmoni_agent_gauge WHERE name='lightmoni.agent.heartbeat' GROUP BY agent_id HAVING max(event_time)+toIntervalSecond(greatest(90,toUInt32OrZero(argMax(attributes['heartbeat_timeout_seconds'],event_time))))>=now()"},
		{&agent, "待发送批次", "line", "SELECT $__timeInterval(event_time) AS time,agent_id AS series,max(value_float) AS value FROM metric_lightmoni_agent_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.agent.queue_batches' GROUP BY time,series ORDER BY time"},
		{&agent, "队列最老批次年龄（秒）", "line", "SELECT $__timeInterval(event_time) AS time,agent_id AS series,max(value_float) AS value FROM metric_lightmoni_agent_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.agent.oldest_age_seconds' GROUP BY time,series ORDER BY time"},
		{&agent, "异常采集项与隔离批次", "line", "SELECT $__timeInterval(event_time) AS time,concat(agent_id,' / ',name) AS series,max(value_float) AS value FROM metric_lightmoni_agent_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.agent.collector_errors','lightmoni.agent.quarantine_batches') GROUP BY time,series ORDER BY time"},
		{&agent, "执行节点日志", "table", "SELECT event_time,agent_id,attributes['group_id'] AS agent_group,severity,body FROM log_lightmoni_agent WHERE $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100"},
		{&sdk, "在线 SDK 实例数", "stat", "SELECT uniqExact(instance_id) AS value FROM metric_lightmoni_sdk_gauge WHERE name='lightmoni.sdk.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND"},
		{&sdk, "在线 SDK · 按服务", "bar", "SELECT service AS category,uniqExact(instance_id) AS value FROM metric_lightmoni_sdk_gauge WHERE name='lightmoni.sdk.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND GROUP BY category ORDER BY value DESC"},
		{&sdk, "待发送批次", "line", "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id) AS series,max(value_float) AS value FROM metric_lightmoni_sdk_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.sdk.pending_batches' GROUP BY time,series ORDER BY time"},
		{&sdk, "累计重试批次", "line", "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id) AS series,max(value_float) AS value FROM metric_lightmoni_sdk_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.sdk.retried_batches' GROUP BY time,series ORDER BY time"},
		{&sdk, "累计丢弃、拒绝、无效与溢出记录", "line", "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id,' / ',name) AS series,max(value_float) AS value FROM metric_lightmoni_sdk_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.sdk.dropped_records','lightmoni.sdk.rejected_records','lightmoni.sdk.invalid_records','lightmoni.sdk.overflow_records') GROUP BY time,series ORDER BY time"},
		{&sdk, "SDK 内部诊断日志", "table", "SELECT event_time,service,instance_id,attributes['sdk.language'] AS language,attributes['source_table'] AS source_table,severity,body FROM log_lightmoni_sdk WHERE $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100"},
	}
	for _, entry := range entries {
		index := len(entry.d.Panels)
		entry.d.Panels = append(entry.d.Panels, systemPanel(entry.d.ID+"-"+string(rune('a'+index)), entry.title, entry.kind, entry.sql, index))
	}
	// Each online execution node contributes once to its category.
	agent.Panels[1].Queries[0].SQL = "SELECT category,count() AS value FROM (" + agent.Panels[1].Queries[0].SQL + ") GROUP BY category ORDER BY value DESC"
	return []Dashboard{center, agent, sdk}
}

// A durable seed marker preserves edits and intentional deletion on restart.
func (m *Module) SeedSystemDashboards(ctx context.Context) error {
	if _, err := m.deps.DB.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS system_dashboard_seeds(id TEXT PRIMARY KEY)"); err != nil {
		return err
	}
	tx, err := m.deps.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, d := range SystemDashboards() {
		var exists int
		if err = tx.QueryRow("SELECT count(*) FROM system_dashboard_seeds WHERE id=?", d.ID).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}
		if err = normalize(&d); err != nil {
			return err
		}
		d.Revision = 1
		d.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		body, _ := json.Marshal(d)
		result, err := tx.Exec("INSERT OR IGNORE INTO dashboards(id,title,body,revision,updated_at) VALUES(?,?,?,?,?)", d.ID, d.Title, string(body), d.Revision, d.UpdatedAt)
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n > 0 {
			if _, err = tx.Exec("INSERT INTO dashboard_versions(dashboard_id,revision,body,updated_at,base_revision) VALUES(?,?,?,?,0)", d.ID, 1, string(body), d.UpdatedAt); err != nil {
				return err
			}
		}
		if _, err = tx.Exec("INSERT INTO system_dashboard_seeds(id) VALUES(?)", d.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
