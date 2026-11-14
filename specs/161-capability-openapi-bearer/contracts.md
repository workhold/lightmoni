# Capability OpenAPI 与 Bearer 契约

`GET /api/v1/openapi.json` 返回当前主体可见的 OpenAPI 3.1 文档。每个能力路径使用真实 `/api/v1/capabilities/<工具名>/invoke`、输入/输出 Schema、capability/version、effect/risk/operationKind、required_scopes 和安全错误，不包含秘密或目标数据。

`GET /api/v1/capabilities` 与 `POST /api/v1/capabilities/:name/invoke` 支持 `Authorization: Bearer <现有 PAT/OAuth>`，复用 McpAccess 的角色、Scope、Host、grant、有效期和审计。无 Authorization 时使用 Web 会话，行为不变。

Bearer 不能提升角色或扩大资源范围，不能用于审批工具自批。OpenAPI 只展示当前主体可见描述符，服务器 URL 来自配置 externalURL。服务主体和持续授权不属于本切片。
