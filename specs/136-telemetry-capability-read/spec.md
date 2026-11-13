# 136 · 遥测只读能力垂直迁移

状态：已实现，已获授权合入 main。继承 SDD 046/047/134/135 和全平台能力开放 Goal，本切片是 Slice 2 的首个领域：遥测目录、表结构和有界只读查询。当前 stacked 基线包含 SDD 134/135；PR #186/#187 未获合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 抽取共享 TelemetryService，内部 AI 的 list_tables、describe_table、run_query 与新 MCP/HTTP 能力复用同一目录和 Query 实现，不复制 SQL 校验或采样逻辑。
2. 保留 `lightmoni_telemetry_catalog`，新增 `lightmoni_telemetry_describe` 和 `lightmoni_telemetry_query`；内部旧工具名保留为 Dispatcher 适配器。
3. 新增 `telemetry.query` Scope；目录和表结构使用 `telemetry.catalog.read`。三者均为安装级数据权限，host_ids 非 null 的外部授权不能发现或调用。
4. 查询继续只允许既有 Query 的只读 SQL、显式 UTC 半开时间范围、90 天上限、参数和 10 秒领域期限；最多 1000 行并增加有界字节采样，截断必须显式。
5. 内部助手现有成员的遥测读取保持不变；外部 PAT/OAuth 仍只向管理员授予 Scope。成员不能因此读取任务或获得外部凭据。
6. MCP 接入页显示新 Scope 的中英文标签；不改变 PAT/OAuth 协议、现有工具响应或 Web 领域 API。
7. 本切片不开放日志专用工具、Trace 专用工具、大盘草稿、告警修改、部署、运维、代码任务或直接执行。

## 非目标

- 不通过追加 WHERE 声称主机级遥测隔离。
- 不开放原始 ClickHouse 连接、任意写入、表函数、SETTINGS/OUTFILE 或非目录表。
- 不将 MCP 请求延长为长任务，不新增队列或微服务。
- 不宣称日志/Trace 专用能力或后续领域已经迁移。

## 验收

1. 内部 list_tables/describe_table/run_query 与外部对应能力经过同一 TelemetryService 和 Dispatcher，旧工具名可用且审计来源正确。
2. telemetry.catalog.read 不能代替 telemetry.query；有限主机授权不能发现或直接调用任何遥测能力。
3. 成员会话只能保留既有遥测读取，不能获得任务/告警/外部授权；管理员外部授权流程保持。
4. SQL/时间/参数在调用 Query 前校验；查询错误、取消和超时如实返回，不伪造成功。
5. 1000 行与字节采样均显式截断，完整 MCP 响应不超过描述符限制。
6. MCP 官方客户端可发现并按 Scope 调用三项能力；内部助手不再注册重复工具。
7. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
