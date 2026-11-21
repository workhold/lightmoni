# SDD 203：已恢复 Agent 的残留生命周期锁闭环

## 背景

`vchive` 旧升级已完成恢复，远端 Agent 回到审批原发行 0.1.8 并在线；SSH 固定检查通过，但残留 `/run/lightmoni-agent-lifecycle.lock` 导致只读 reconcile 误判为“不空闲/维护进程仍在”。现有状态修正流程只处理 Agent 缺失场景，无法闭环仍健康运行的 Agent。

## 目标

在 `rollback_failed + recovery_original_unhealthy` 特例的只读核对中，增加残留生命周期锁的受控清理：

1. 中心先固定只读 probe，证明 Agent 身份、原发行指纹、运行模式、权限代次、helper、服务状态与审批一致。
2. 仅确认更新 worker 单元 inactive/not-found、cgroup 空、无 worker 进程后，才允许清理残留 lifecycle lock。
3. 清理后立刻重新执行标准 probe；任一证据不一致立即拒绝并保留锁。
4. 清理动作写入更新回执与审计，不重放恢复、升级、安装或卸载。
5. 其余场景不得清理锁。

## 非目标

- 不自动清理 operation lock、任务执行锁或任何未知业务执行。
- 不移除健康 Agent。
- 不绕过管理员审批或恢复复核门。
- 不改变原生恢复事务协议。

## 验收

1. `rollback_failed + recovery_original_unhealthy` 且原发行证据匹配、worker 已停止、仅残留 lifecycle lock 时，只读 reconcile 可清理锁并闭环 `rolled_back`。
2. worker 运行、任务锁存在、原发行漂移或身份不匹配时拒绝，且不清理锁。
3. 清理与最终 probe 证据持久化在回执。
4. Runtime/API 回归通过。
