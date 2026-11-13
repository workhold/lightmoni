# 实施计划

## 1. ExecutionGrantRegistry

- 新表关联 domain/native_id、grant/user、来源、原因和时间；同 ID 异授权拒绝覆盖。
- 支持可装配 validator；有绑定但无 validator 时 fail closed，无绑定表示内部原生操作。
- 中心 SSH 对 ordinary Agent Job 通过 deployment_id 查找并复验；授权失败只终止未开始 Job，不重放。

## 2. 部署能力

- deployments.plan 要求 deployments.propose + deployments.read、admin、allHosts=true。
- 使用 ServiceDeploymentStore.assistantPlan 创建原计划；在同一 SQLite 事务保存幂等与 deployment grant。
- proposal 状态仅表示 awaiting_approval/completed（审批接受），native_status 另行读取真实部署，不把 agent_ready 当作成功。
- 审批事务中再次执行 ExecutionGrantRegistry.assert。

## 3. 内部助手与验证

- propose_service_deployment 使用 Dispatcher，保留旧名称和计划返回形态。
- 官方 SDK 验证计划、审批、状态读取、权限和撤销。
- 复跑部署/Agent/SSH/核心回归，执行类型检查、构建和 runtime 全量。
- 更新系统设计、平台 MCP 和接入指南，创建面向 main 的 stacked PR，不合并。
