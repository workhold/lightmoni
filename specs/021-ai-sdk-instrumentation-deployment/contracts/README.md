# SDD 021 契约索引

- [HTTP 与 AI 工具](api.md)
- [部署适配器](deployment-adapter.md)
- [Agent Job 与执行器](agent-executor.md)
- [SDK 插桩](instrumentation.md)

这些契约描述目标接口。实现或历史接口不一致时，应在对应 SDD 任务中记录兼容策略，并以运行时代码和验证结果为当前事实。

## 当前实现边界

本目录的 HTTP、插桩和 Agent job 契约按切片标注实现边界。当前分支已提供：

- `GET/POST /api/v1/services`、`GET /api/v1/services/:id`；
- `GET/POST/PATCH /api/v1/services/:id/targets`；
- `GET/POST /api/v1/services/:id/releases`；
- `GET /api/v1/services/:id/deployments`、`POST /api/v1/services/:id/deployments/plan`（其中 POST 只生成 `awaiting_approval` 通用计划）；
- `GET /api/v1/services/:id/deployments/:deploymentId`、`GET /api/v1/deployments/:deploymentId`、两种作用域的 deployment events 查询；
- 管理员 `POST /api/v1/deployments/:deploymentId/approve` 与 `rollback`，前者检查 Agent 就绪、创建不可变 job 并推进到 `agent_ready`，后者只生成 `rollback_pending` 提案，不执行主机动作；
- 管理员 `POST /api/v1/instrumentation-plans/:id/apply`，校验 revision、路径、符号链接和大小限制后原子应用已批准的插桩 diff；插桩计划本身仍是 AI 调用期间的受控记录；
- AI 的 `scan_sdk_instrumentation`、只读 `propose_sdk_instrumentation`、`list_services`、`propose_service_deployment`、`get_service_deployment`、`get_service_deployment_events` 工具。

当前仍没有 release 构建或真实健康/遥测验证接口；插桩 apply HTTP 已接入，但没有独立持久化的 `instrumentation_plans` 表。Agent job 的 claim/lease/event/result/cancel、MVP capability executor 和 Agent runner 已接入，但生产签名校验、主机 preflight、真实 ClickHouse 验证和部署最终状态闭环仍待后续切片。`propose_sdk_instrumentation` 只在 AI 工具调用期间生成内存中的只读计划，调用方必须以运行时代码为准，不能把下方目标请求当作已部署 API。
