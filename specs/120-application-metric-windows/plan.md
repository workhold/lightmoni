# 设计与实现计划

1. 先补回归：真实 Executor + sdkTelemetryQueries 证明非边界当前时间触发错误；覆盖 30 秒、七档周期、混合历史和普通 SQL 严格拒绝。
2. `telemetry-queries.ts` 的 SDK 指标使用统一时间宏，不内联原请求时间；按实际 histogram window_seconds 选择 window_start 或 event_time 为 metric_time，按执行器最终 interval 分桶。日志仍使用原文字时间过滤。
3. `query.ts` 对精确 source=application-monitoring 复用现有自动窗口对齐；查询只有涉及固定窗口表时才发生变化，其余查询范围不变。对齐前元数据发现应包含与原范围重叠的窗口，避免边界窗口遗漏周期识别。
4. SDKTelemetry 使用 sdk_metrics frame 的 metric_window_alignment.range 绘图，其他图表继续 data.range。不增加查询或数据副本。
5. 定向测试、runtime/web 类型检查、隔离真实 ClickHouse 与应用页面复核，记录结果。原 PR #163 的内存标题改动保留在原分支，本次独立 PR。
