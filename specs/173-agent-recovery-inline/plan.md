# SDD 173 实施计划

1. 在 Agent 更新 SSH 固定命令中加入受限恢复运行时选择，只让只读 probe/status 和已审批恢复复用；commit、主动 rollback 与正常启动路径不变。
2. 对候选目录、文件、摘要和可执行性逐项验证，失败时只输出固定 `agent_recovery_runtime_unavailable`，不返回原始远端输出或秘密。
3. 扩展现有 `AgentUpdateProgress`，复用原 GET/reconcile/recover API、revision 与凭据边界，增加管理员核对和恢复审批。
4. 添加 shell fixture、原恢复领域回归和隔离浏览器交互，覆盖成功、拒绝、重复提交围栏及成员不可见。
5. 更新 `docs/system-design.md`，运行相关验证并通过 PR 交付。
