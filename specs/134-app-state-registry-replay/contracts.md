# 契约

- Agent 本地配置沿用 `max_age_seconds`（默认 86400 秒）作为批次接收年龄上限。新增 `max_retention_seconds`（正整数秒，默认 3600）和 `replay_interval_ms`（1–60000 毫秒，默认 1000）。旧配置加载时自动取得新字段默认值；有效待发送保留窗口为两个年龄参数的较小值。配置格式不含凭据变更。
- Agent 队列：pending 批次创建时间早于当前时间减去有效窗口时不再上送且删除 payload；receipt 仍按 `receipt_seconds` 独立到期；quarantine 的人工核对语义不变。`queue_expired` 运行事件仅含数量。
- Docker 日志：读取起点不早于当前时间减去有效窗口；日志原始 `timeUnixNano` 不重写；游标序号单调。
- 应用列表：`resourceState` 可返回 `unverified`，文案“待核实”；现有 API 响应字段不变。
- 仓库版本查询：409 `privileged_execution_pending` 仍禁止创建作业；前端展示主机执行记录入口，不自动清除围栏。
