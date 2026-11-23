## 契约

### Docker 只读核对

- 允许输出仍限制为固定 schema、固定枚举和 <=2048 字节。
- 新增失败码 `docker_install_evidence_untrusted`，phase 为 `unknown`。
- `docker_install_not_started` 必须覆盖安装根目录或操作目录不存在。
- 失败记录允许再次发起新的审阅安装；unknown 记录仍禁止重复维护。

### Agent 运行模式列表

- `GET /machines/:id/agent-runtime/plans` 只返回当前 `agent_id` 匹配的记录。
- 每条记录仍须通过既有 revision、mode、generation 和账户校验。

### AI 主机工具

- `list_managed_machines` 返回核心 MachineSummary 白名单。
- `get_managed_machine` 返回同一白名单，加 `ssh_credentials` 元数据（id/account/username/revision/method/expires_at）。
- 禁止返回 `accounts`、`network.addresses`、`host_key_*`、最近 SSH 检查原始输出或任何凭据材料。
