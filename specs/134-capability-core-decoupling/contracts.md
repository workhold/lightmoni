# 核心解耦契约

## 主体与访问职责

核心 `CapabilityAccess` 提供 `sessionPrincipal(user, source)`，其中 source 仅允许 `web` 或 `assistant`。会话 Principal 使用服务端当前活跃用户、当前角色对应的 Scope、`host_ids=null`，且 credential/grant 为空。

Dispatcher 依赖核心访问接口，不再依赖具体 McpAccess。对于 `source=web/assistant`，核心访问模块重新读取账户并刷新 Principal；对于 `source=mcp`，必须委托外部访问模块执行凭据和 grant 校验。

外部访问模块不存在时：

- Web/助手调用继续工作；
- 外部 Principal 校验失败；
- `validateGrant` 返回授权不可用；
- 外部提案审批失败，原生任务、执行和授权关联均不创建。

## 应用装配

以下对象不受 MCP externalURL 合法性影响：

- CapabilityDispatcher；
- TaskProposalService 共享实例；
- `GET /api/v1/capabilities`；
- `POST /api/v1/capabilities/:name/invoke`；
- 内部助手首批共享任务工具。

以下对象仅在 MCP externalURL 合法时启用：

- McpAccess 及其 PAT/OAuth 表与管理接口；
- OAuth 发现、授权和 token 端点；
- `/api/v1/mcp` 的真实 MCP Transport。

MCP 禁用时 `/api/v1/mcp-access` 和 `/api/v1/mcp` 继续返回明确的 503，不把核心能力禁用误报为整个平台故障。

## 兼容

既有 `lightmoni_*` 工具、Principal 字段、Scope、TaskProposalService 公共行为、审批页面、执行 ID 和响应字段不变。本切片只调整依赖归属和装配条件，不引入新的外部业务能力。

## 审计与安全

核心调用继续写 `capability_invocations`；来源由入口设置。会话 Principal 不伪造 credential/grant，外部 Principal 不接受模型传入的身份。任何授权适配器缺失都不得把 `source=mcp` 改写为 assistant/web。
