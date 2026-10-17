import type { Dependencies } from "../shared/types.js";
export function registerTemplates(d: Dependencies) {
  d.router.get("/api/v1/templates", async (c) => {
    const items: any[] = [];
    for (const t of await d.cat.list(c.signal)) {
      let title = "",
        description = "",
        sql = "";
      if (t.kind === "log") {
        title = "日志错误趋势";
        description = "按服务统计每个时间桶的ERROR及更高级别日志";
        sql = `SELECT $__timeInterval(event_time) AS time, service AS series, count() AS value FROM ${t.name} WHERE $__timeFilter(event_time) AND severity_number >= 17 GROUP BY time,series ORDER BY time`;
      } else if (t.kind === "trace") {
        title = "链路耗时趋势";
        description = "按服务显示调用平均毫秒耗时";
        sql = `SELECT $__timeInterval(start_time) AS time, service AS series, avg(duration_ns)/1000000 AS value FROM ${t.name} WHERE $__timeFilter(start_time) GROUP BY time,series ORDER BY time`;
      } else if (t.kind === "metric") {
        if (t.metric_type === "sum") {
          title = "业务计数趋势";
          description = "Delta指标按时间、服务和指标名称汇总";
          sql = `SELECT $__timeInterval(event_time) AS time, concat(service, ' / ', name) AS series, sum(toDecimal256(value_int,0)) AS value FROM ${t.name} WHERE $__timeFilter(event_time) AND temporality='DELTA' GROUP BY time,series ORDER BY time`;
        }
        if (t.metric_type === "gauge") {
          title = "机器与业务观测值";
          description = "按机器与指标显示时间桶平均观测值；可编辑筛选指标名";
          sql = `SELECT $__timeInterval(event_time) AS time, concat(host_id, ' / ', name) AS series, avg(value) AS value FROM ${t.name} WHERE $__timeFilter(event_time) GROUP BY time,series ORDER BY time`;
        }
        if (t.metric_type === "histogram") {
          title = "延迟分布平均值";
          description = "以sum/count计算加权平均；不能平均各实例分位数";
          sql = `SELECT $__timeInterval(event_time) AS time, concat(service, ' / ', name) AS series, sum(sum)/nullIf(sum(count),0) AS value FROM ${t.name} WHERE $__timeFilter(event_time) AND temporality='DELTA' GROUP BY time,series ORDER BY time`;
        }
      }
      if (sql)
        items.push({
          id: t.id + "-trend",
          title,
          description,
          type: "line",
          table_id: t.id,
          sql,
          options: { x: "time", y: "value", series: "series" },
        });
      if (t.kind === "log")
        items.push({
          id: t.id + "-levels",
          title: "日志级别占比",
          description: "查看查询范围内各级别日志数量",
          type: "pie",
          table_id: t.id,
          sql: `SELECT severity AS category,count() AS value FROM ${t.name} WHERE $__timeFilter(event_time) GROUP BY category ORDER BY value DESC`,
          options: { x: "category", y: "value" },
        });
      if (
        t.kind === "metric" &&
        t.metric_type === "gauge" &&
        t.logical_name.includes("host")
      )
        items.push({
          id: t.id + "-cpu",
          title: "主机 CPU",
          description: "主机CPU利用率，0到1，可设百分比单位",
          type: "line",
          table_id: t.id,
          sql: `SELECT $__timeInterval(event_time) AS time, host_id AS series, avg(value) AS value FROM ${t.name} WHERE $__timeFilter(event_time) AND name='host.cpu.utilization' GROUP BY time,series ORDER BY time`,
          options: {
            x: "time",
            y: "value",
            series: "series",
            unit: "percentunit",
          },
        });
    }
    c.json(items);
  });
}
