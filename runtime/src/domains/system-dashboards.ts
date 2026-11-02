// Built-in dashboard definitions preserve the existing durable seed IDs.
export const systemDashboards = (): any[] => [
  {
    id: "system-center",
    title: "系统监控 · 上报中心",
    description:
      "内置自监控：上报接口 QPS、持久化接收量、错误、耗时、运行状态和系统日志。QPS 按最近一分钟平均；接收量只统计首次确认成功的批次，不重复计算补传。",
    range: {
      from: "now-1h",
      to: "now",
    },
    refresh: 10,
    panels: [
      {
        id: "system-center-a",
        title: "上报接口 QPS（最近一分钟）",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT coalesce(sum(value_float),0)/60 AS value FROM lightmoni_metric_sum WHERE name='lightmoni.center.ingest_requests' AND event_time>=now()-INTERVAL 1 MINUTE",
          },
        ],
        options: {
          y: "value",
          decimals: 2,
        },
        grid: {
          x: 0,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-b",
        title: "最近一分钟接收记录数",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT coalesce(sum(value_float),0) AS value FROM lightmoni_metric_sum WHERE name='lightmoni.center.received_records' AND event_time>=now()-INTERVAL 1 MINUTE",
          },
        ],
        options: {
          y: "value",
          decimals: 0,
        },
        grid: {
          x: 6,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-c",
        title: "接口 QPS · 按响应状态",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT toStartOfMinute(event_time) AS time,concat(attributes['signal'],' / ',attributes['status']) AS series,sum(value_float)/60 AS value FROM lightmoni_metric_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.ingest_requests' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
          decimals: 2,
        },
        grid: {
          x: 0,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-d",
        title: "接收记录数 · 每分钟",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT toStartOfMinute(event_time) AS time,attributes['signal'] AS series,sum(value_float) AS value FROM lightmoni_metric_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.received_records' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-e",
        title: "接收字节数 · 每分钟",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT toStartOfMinute(event_time) AS time,attributes['signal'] AS series,sum(value_float) AS value FROM lightmoni_metric_sum WHERE $__timeFilter(event_time) AND name='lightmoni.center.received_bytes' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 12,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-f",
        title: "上报请求平均耗时（毫秒）",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,attributes['signal'] AS series,sum(sum)/nullIf(sum(count),0) AS value FROM lightmoni_metric_histogram WHERE $__timeFilter(event_time) AND name='lightmoni.center.ingest_duration' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 12,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-g",
        title: "在线中心实例数",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT uniqExact(instance_id) AS value FROM lightmoni_metric_gauge WHERE name='lightmoni.center.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND",
          },
        ],
        options: {
          y: "value",
          decimals: 0,
        },
        grid: {
          x: 0,
          y: 18,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-h",
        title: "上报失败数（最近一分钟）",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT coalesce(sum(value_float),0) AS value FROM lightmoni_metric_sum WHERE name='lightmoni.center.ingest_requests' AND attributes['status']!='200' AND event_time>=now()-INTERVAL 1 MINUTE",
          },
        ],
        options: {
          y: "value",
          decimals: 0,
        },
        grid: {
          x: 6,
          y: 18,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-i",
        title: "中心运行状态",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,name AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.center.pending_batches','lightmoni.center.dropped_records') GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 24,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-j",
        title: "堆内存（字节）",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,instance_id AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.center.heap_bytes' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 24,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-k",
        title: "Node 活跃资源数",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,instance_id AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.center.active_resources' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 30,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-center-event-loop",
        title: "Node 事件循环延迟（毫秒）",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,instance_id AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.center.event_loop_delay_ms' GROUP BY time,series ORDER BY time",
          },
        ],
        options: { x: "time", y: "value", series: "series", decimals: 2 },
        grid: { x: 0, y: 36, w: 12, h: 6 },
      },
      {
        id: "system-center-l",
        title: "中心运行日志",
        type: "table",
        queries: [
          {
            refId: "A",
            sql: "SELECT event_time,severity,body FROM lightmoni_log WHERE component='center' AND $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 30,
          w: 6,
          h: 6,
        },
      },
    ],
  },
  {
    id: "system-agent",
    title: "系统监控 · 执行节点",
    description:
      "按最近心跳统计在线执行节点，默认 90 秒超时（或控制周期的三倍）。LightMoni Agent 停止后在线数会降至零；支持在图表设置中配置低于预期在线数等告警。",
    range: {
      from: "now-1h",
      to: "now",
    },
    refresh: 10,
    panels: [
      {
        id: "system-agent-a",
        title: "在线执行节点数",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT uniqExact(agent_id) AS value FROM lightmoni_metric_gauge WHERE name='lightmoni.agent.heartbeat' AND event_time+toIntervalSecond(greatest(90,toUInt32OrZero(attributes['heartbeat_timeout_seconds'])))>=now()",
          },
        ],
        options: {
          y: "value",
          decimals: 0,
        },
        grid: {
          x: 0,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-agent-b",
        title: "在线执行节点 · 按节点",
        type: "bar",
        queries: [
          {
            refId: "A",
            sql: "SELECT category,count() AS value FROM (SELECT agent_id AS category,agent_id FROM lightmoni_metric_gauge WHERE name='lightmoni.agent.heartbeat' GROUP BY agent_id HAVING max(event_time)+toIntervalSecond(greatest(90,toUInt32OrZero(argMax(attributes['heartbeat_timeout_seconds'],event_time))))>=now()) GROUP BY category ORDER BY value DESC",
          },
        ],
        options: {
          x: "category",
          y: "value",
        },
        grid: {
          x: 6,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-agent-c",
        title: "待发送批次",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,agent_id AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.agent.queue_batches' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-agent-d",
        title: "队列最老批次年龄（秒）",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,agent_id AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.agent.oldest_age_seconds' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-agent-e",
        title: "异常采集项与隔离批次",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,concat(agent_id,' / ',name) AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.agent.collector_errors','lightmoni.agent.quarantine_batches') GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 12,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-agent-f",
        title: "执行节点日志",
        type: "table",
        queries: [
          {
            refId: "A",
            sql: "SELECT event_time,agent_id,severity,body FROM lightmoni_log WHERE component='agent' AND $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 12,
          w: 6,
          h: 6,
        },
      },
    ],
  },
  {
    id: "system-sdk",
    title: "系统监控 · SDK",
    description:
      "业务 SDK 每 30 秒报告进程实例心跳、缓冲与诊断。90 秒无心跳视为离线；内部数据单独入表，不需要增加业务 Key 的 table 权限。",
    range: {
      from: "now-1h",
      to: "now",
    },
    refresh: 10,
    panels: [
      {
        id: "system-sdk-a",
        title: "在线 SDK 实例数",
        type: "stat",
        queries: [
          {
            refId: "A",
            sql: "SELECT uniqExact(instance_id) AS value FROM lightmoni_metric_gauge WHERE name='lightmoni.sdk.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND",
          },
        ],
        options: {
          y: "value",
          decimals: 0,
        },
        grid: {
          x: 0,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-sdk-b",
        title: "在线 SDK · 按服务",
        type: "bar",
        queries: [
          {
            refId: "A",
            sql: "SELECT service AS category,uniqExact(instance_id) AS value FROM lightmoni_metric_gauge WHERE name='lightmoni.sdk.heartbeat' AND event_time>=now()-INTERVAL 90 SECOND GROUP BY category ORDER BY value DESC",
          },
        ],
        options: {
          x: "category",
          y: "value",
        },
        grid: {
          x: 6,
          y: 0,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-sdk-c",
        title: "待发送批次",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id) AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.sdk.pending_batches' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-sdk-d",
        title: "累计重试批次",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id) AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name='lightmoni.sdk.retried_batches' GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 6,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-sdk-e",
        title: "累计丢弃、拒绝、无效与溢出记录",
        type: "line",
        queries: [
          {
            refId: "A",
            sql: "SELECT $__timeInterval(event_time) AS time,concat(service,' / ',instance_id,' / ',name) AS series,max(value_float) AS value FROM lightmoni_metric_gauge WHERE $__timeFilter(event_time) AND name IN ('lightmoni.sdk.dropped_records','lightmoni.sdk.rejected_records','lightmoni.sdk.invalid_records','lightmoni.sdk.overflow_records') GROUP BY time,series ORDER BY time",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 0,
          y: 12,
          w: 6,
          h: 6,
        },
      },
      {
        id: "system-sdk-f",
        title: "SDK 内部诊断日志",
        type: "table",
        queries: [
          {
            refId: "A",
            sql: "SELECT event_time,service,instance_id,attributes['sdk.language'] AS language,attributes['source_table'] AS source_table,severity,body FROM lightmoni_log WHERE component='sdk' AND $__timeFilter(event_time) ORDER BY event_time DESC LIMIT 100",
          },
        ],
        options: {
          x: "time",
          y: "value",
          series: "series",
        },
        grid: {
          x: 6,
          y: 12,
          w: 6,
          h: 6,
        },
      },
    ],
  },
];
