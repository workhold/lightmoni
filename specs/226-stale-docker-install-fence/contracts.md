## 契约

- 新增固定失败码 `docker_install_target_changed`，phase 固定为 `unknown`。
- 旧 Agent 身份的 `running/unknown` 记录在服务启动时收敛为该失败码。
- 目标变化的核对回执不发起 SSH，不重放安装。
- 只有当前 Agent ID 与目标修订一致的记录才继续只读核对流程。
