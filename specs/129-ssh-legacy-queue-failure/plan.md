# 实施计划

**规格**：[spec.md](spec.md)

1. 在受管桥接 `prepare()` 的 `HTTPError` 处理处识别精确 `agent_upgrade_required`，调用原 Agent 作业存储的 `failQueuedSSH(jobID, code)`；其他审批错误继续原取消路径。`failQueuedSSH` 已限制 `queued` 状态，并通过既有事务写回执、事件和领域通知。
2. 在 `managed-executor-jobs.test.ts` 构造升级前已入队的作业，然后将中心切到 SSH 模式、建立有效 SSH 绑定、提交旧 helper 的签名发行心跳，调用 `prepareSSH`。断言原作业 `failed`、回执码精确、没有签名作业或 SSH 执行。保留兼容发行的现有正常路径回归。
3. 执行聚焦测试、runtime 类型检查和差异检查，记录验证结果。提交前同步 GitHub `main`，以功能分支创建 PR 并合入。

## 兼容与架构

新创建的旧发行计划仍由 SDD127 预排队门禁拒绝；本次仅改正更早版本留下的队列结果。没有新字段或数据迁移。架构影响不适用，理由见 [规格](spec.md#架构影响)。
