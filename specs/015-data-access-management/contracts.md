# Contracts

## 路由

- `/data?tab=sdk|agent`：接入流程。
- `/admin?tab=credentials&section=sdk|enrollments|agents`：管理员凭据管理，默认 sdk。
- `/data-management`：目录与表级设置；成员只读，管理员沿用既有修改权限。
- 旧 keys/tables/templates 深链用 replace 跳转；keys 对成员回到 SDK 接入，避免访问管理员界面。

## API

- 继续使用 `/api/v1/keys`、`/keys/:id`、`/keys/:id/events`，不改返回字段或权限。
- `GET /api/v1/agent-enrollments`：继续返回数组；`status` 为有效状态（issued、pending_activation、active、expired、cancelled），无明文/哈希；issued 以 expires_at，pending_activation 以 pending_expires_at 和 expires_at 判过期。
- `POST /api/v1/agent-enrollments/:id/revoke`：管理员撤销 issued/pending_activation 令牌，已撤销幂等成功；不存在 404，已激活或过期 409。响应 `{ok:true}`，不撤销已签发节点凭据。撤销后兑换及激活均拒绝。
- `GET /api/v1/agent-credentials`：管理员读取最多最近 200 条元数据，返回数组：`id,agent_id,audience,scope,created_at,last_used_at,expires_at,revoked_at,revoke_reason,status`；status 为 active/expired/revoked，绝不包含 token_hash 或明文。
- `POST /api/v1/agents/:id/credentials/revoke`：沿用既有按 agent_id 和 audience 撤销行为，不把单行操作伪装为仅撤销该 id。

## 凭据区别

SDK data key 允许业务上报到指定逻辑表；Agent enrollment token 是一次性、短时接入凭据；control 用于节点控制通道，data 用于节点遥测上报。SDK 本地 token 不在中心生成或回显；页面说明由目标 Agent 配置管理。
