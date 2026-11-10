# 查询契约

- `GET /api/v1/ops/resources/:id/telemetry` 的响应结构、原 range、查询身份筛选与 refId 保持。
- SDK 指标通过 `$__timeFilter(metric_time/event_time)`、`$__timeInterval(metric_time/event_time)` 绑定最终边界和间隔。固定窗口 histogram 的 metric_time=window_start，非固定窗口点=event_time。
- source=application-monitoring 时，执行器在涉及固定窗口的查询上复用 dashboard/alert 的公倍数对齐并返回原有 `frames[].meta.metric_window_alignment={range,interval_ms}`；SDK 指标绘图使用该实际范围。
- 元数据发现包含 window_start<to 且 window_start+window_seconds>from 的重叠窗口；window_seconds=0 不引入对齐。
- 普通查询仍须自己传入符合周期的范围/步长；容器、日志、网站查询无 window_seconds 元数据，保持原精确时间。
- 不增加 API/字段、存储或 Agent 协议。错误状态按原逻辑保留。
