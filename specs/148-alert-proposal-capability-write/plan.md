# 实施计划

## 1. AlertProposalService 来源与授权

- StoredProposal 增加 source；create 保持内部接口，createFrom 接收 assistant/mcp/web 来源。
- 外部来源要求 grant_id、session_id 为空；内部仍要求真实 session_id。
- 增加可装配 beforeApply 授权 hook；MCP 来源缺少 hook 时返回 503，审批前执行，内部历史提案不变。

## 2. 告警能力

- 新增 alerts.plan 描述符，effect=propose、risk=R2、domain_change、domain_native 审批和 required_external 幂等。
- 主 Scope alerts.propose，additionalScopes=[alerts.detail.read]；list 和 invoke 都要求全部。
- Dispatcher 配置共享 AlertProposalService 的外部授权 hook，复验 grant、两个 Scope 和 allHosts。
- 使用 capability_idempotency 的同一主体/能力/key 域，返回原提案且不重写原配置。

## 3. 内部助手与验证

- propose_alert_change 使用 Dispatcher 创建告警提案，保留旧名称和会话。
- 官方 SDK 验证规则与静默提案、审批、回读、权限和撤销。
- 复跑原告警/助手/MCP/核心回归，执行类型检查、构建和 runtime 全量。
- 更新系统设计、平台 MCP 和接入文档，创建面向 main 的 stacked PR，不合并。
