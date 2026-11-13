# 契约

- `POST /api/v1/machines/:id/agent-updates/start`，管理员权限，请求 `{}`；响应 `202 AgentUpdate`。请求本身为单机升级授权。默认可复用 SSH 凭据、远端架构、最新匹配发行由服务端决定。若存在未完成维护返回 409 并保留原记录。
- `GET /api/v1/machines/:id/agent-updates/:updateId` 的 `AgentUpdate` 增加 `events: [{at,stage}]`，阶段为固定服务端枚举；既有字段和旧接口不变。事件不携带原始 SSH 输出。
- 安全门禁：未领取 queued 工作可等待；任何已领取、运行中、unknown 或证据不完整工作仍阻断维护。维护开始后现有领取及新派发栅栏持续生效。
