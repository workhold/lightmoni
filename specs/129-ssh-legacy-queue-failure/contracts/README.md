# 历史受管队列失败契约

- 输入：`agent_jobs` 中 `execution_principal='privileged_executor'`、`state='queued'`，且当前绑定 helper 不能证明 `managed-once`。
- 输出：原 `agent_jobs` 更新为 `state='failed'`，回执与事件的 `code='agent_upgrade_required'`；关联领域通过现有通知得到失败。不得创建对应 `privileged_jobs` 或运行 SSH。
- `failQueuedSSH` 对非 `queued` 记录无状态修改；`leased`、`unknown` 等沿原恢复契约。
- 只有该精确升级错误采用失败契约。审批者失效、资源修订变化等其他 HTTP 错误沿原取消行为，不误用升级码。
