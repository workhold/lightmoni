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
- 管理员 `GET/POST /api/v1/services/:id/targets/:targetId/preflight`：只读 systemd preflight job 和目标 revision/一次性 request ID 绑定的 10 分钟快照；中心核对观测时间和回执绑定，并按目标状态、配置与 Agent 身份失效旧快照；不会推进业务 deployment 状态；
- `GET/POST /api/v1/services/:id/releases`；
- 管理员 `PUT /api/v1/services/:id/releases/:releaseId/artifact` 上传摘要校验后的私有 bundle；Agent 通过 `GET /api/v1/agents/:agentId/jobs/:jobId/artifacts/:releaseId` 在 control credential + 当前 job lease 下下载；上传与 Agent 暂存共用启发式凭据扫描，拒绝常见凭据路径、私钥/知名 token、URL/DSN userinfo、凭据查询参数、Basic Auth 和有值凭据字段，但不保证发现所有秘密；失败上传的私有 blob 留待引用感知 GC；
- `GET /api/v1/services/:id/deployments`、`POST /api/v1/services/:id/deployments/plan`（ready bundle + 新鲜 ready preflight 可生成 systemd typed actions；缺少条件时仍为不可执行的 `awaiting_approval` 计划）；
- `GET /api/v1/services/:id/deployments/:deploymentId`、`GET /api/v1/deployments/:deploymentId`、两种作用域的 deployment events 查询；
- 管理员 `POST /api/v1/deployments/:deploymentId/approve` 与 `rollback`；approve 检查 Agent 就绪和带授权的 health_check，创建不可变 job 并推进到 `agent_ready`，之后将 Agent 的有序回执映射为部署状态；rollback 仅在新鲜 preflight 显示本次部署版本仍为 current、previous version 已登记为同一 service 的 ready release 且 Agent 在线时创建受限 Agent job，并核对健康/current-version 回执后进入 `rolled_back`；未知或不匹配回执会终结本次操作、将部署标记为 `failed` 并保留 `unknown` receipt，管理员检查主机并完成新的安全 preflight 后才可显式重试；
- 管理员 `POST /api/v1/instrumentation-plans/:id/apply`，校验 revision、路径、符号链接和大小限制后原子应用已批准的插桩 diff；插桩计划本身仍是 AI 调用期间的受控记录；
- AI 的 `scan_sdk_instrumentation`、只读 `propose_sdk_instrumentation`、`list_services`、`propose_service_deployment`、`get_service_deployment`、`get_service_deployment_events` 工具。
- `lightmoni-release-v1.tar.gz` 严格 USTAR 校验、digest 私有存储、Agent lease 下载、上传与 Agent 暂存共用的启发式凭据扫描、Linux Agent 安全解包和 CAS 相对 symlink 激活；受管目录权限由 root/Agent service group 管理，业务 service user 只读。凭据扫描仅拦截常见特征，不构成制品无秘密证明。

当前仍没有自动 release 构建、部署后的中心真实健康任务、ClickHouse 遥测验证和自动补偿；人工 systemd 回滚 job、回滚未知结果的人工复核终态与 `rolled_back` 回执已接入。插桩 apply HTTP 已接入，但没有独立持久化的 `instrumentation_plans` 表。Agent job 的 claim/lease/event/result/cancel、严格序号/阶段校验、MVP capability executor、只读 systemd preflight、Agent runner 和部署最终健康回执状态映射已接入；生产签名校验、artifact GC/配额与 Linux 实机验收仍待后续切片。普通部署已领取 job 的取消和租约过期会保留最后已知状态与 `unknown` receipt；回滚操作则关闭当前 operation，要求管理员检查主机并重新预检，系统不自动重试。`propose_sdk_instrumentation` 只在 AI 工具调用期间生成内存中的只读计划，调用方必须以运行时代码为准，不能把下方目标请求当作已部署 API。
