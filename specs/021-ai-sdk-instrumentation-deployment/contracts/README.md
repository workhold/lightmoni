# SDD 021 契约索引

- [HTTP 与 AI 工具](api.md)
- [部署适配器](deployment-adapter.md)
- [Agent Job 与执行器](agent-executor.md)
- [SDK 插桩](instrumentation.md)

这些契约描述目标接口。实现或历史接口不一致时，应在对应 SDD 任务中记录兼容策略，并以运行时代码和验证结果为当前事实。

## 当前实现边界

本目录的 HTTP、插桩和 Agent job 契约是目标设计，不表示接口已经全部存在。当前分支已提供：

- `GET/POST /api/v1/services`、`GET /api/v1/services/:id`；
- `GET/POST/PATCH /api/v1/services/:id/targets`；
- `GET/POST /api/v1/services/:id/releases`；
- `GET /api/v1/services/:id/deployments`、`POST /api/v1/services/:id/deployments/plan`（其中 POST 只生成 `awaiting_approval` 通用计划）；
- `GET /api/v1/services/:id/deployments/:deploymentId`、`GET /api/v1/deployments/:deploymentId`、两种作用域的 deployment events 查询；
- 管理员 `POST /api/v1/deployments/:deploymentId/approve` 与 `rollback`，前者只推进到 `agent_ready`，后者只生成 `rollback_pending` 提案，不执行主机动作；
- AI 的 `scan_sdk_instrumentation`、只读 `propose_sdk_instrumentation`、`list_services`、`propose_service_deployment`、`get_service_deployment`、`get_service_deployment_events` 工具。

当前没有持久化的插桩 plan HTTP/apply、release 构建、deployment 执行、Agent job claim/lease/event/result 或真实健康/遥测验证接口。`propose_sdk_instrumentation` 只在 AI 工具调用期间生成内存中的只读计划，调用方必须以运行时代码为准，不能把下方目标请求当作已部署 API。
