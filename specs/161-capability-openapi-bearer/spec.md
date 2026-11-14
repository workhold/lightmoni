# 161 · Capability OpenAPI 与普通程序 Bearer 调用

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～160 和全平台能力开放 Goal，本切片完成 Slice 4 的普通程序接口基础：OpenAPI 与 Bearer 调用。PR #208～#214 和依赖 PR #215 均未获本轮合并授权，本切片 stacked 在 #215 上并独立创建 PR，不自动合并。

## 需求与范围

1. 新增 `GET /api/v1/openapi.json`，从当前主体可见的 HTTP 能力描述符生成 OpenAPI 3.1，包含真实输入/输出 Schema、capability/version、effect、risk、operationKind、Scope 和安全响应。
2. `GET /api/v1/capabilities` 与 `POST /api/v1/capabilities/:name/invoke` 支持现有 PAT/OAuth Bearer，复用 McpAccess.authenticate 和同一 Principal、Scope、Host、限流、审计与业务行为；不模拟 MCP。
3. 无 Authorization 时继续使用 Web 会话；Bearer 失效、MCP 接入未配置或越权时失败关闭，不能提升账户角色或主机范围。
4. OpenAPI 仅展示当前主体可见能力，不包含凭据、秘密、真实目标数据或供应商信息；服务器 URL 来自配置而非请求 Host。
5. 不开放通用 apply/approve/execute、服务主体、持续授权或第二套权限系统。

## 非目标

- 不改变现有 MCP 工具名称、请求/响应或审批状态机。
- 不宣称服务账户、持续授权、真实客户端矩阵或完整 Slice 5 已完成。

## 验收

1. PAT Bearer 可发现/调用其 Scope 内能力，审计 source=mcp；越权与无效 Bearer 被拒绝。
2. Web 会话行为不变；OpenAPI 与当前主体可见描述符一致，输入/输出 Schema 和安全元数据完整。
3. 官方 HTTP 客户端可直接调用，不需要 MCP 协议；相关回归、类型检查、构建和 runtime 全量有真实记录。
