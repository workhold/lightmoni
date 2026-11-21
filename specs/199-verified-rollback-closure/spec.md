# SDD 199：已恢复原发行的健康核对闭环

## 背景

`rollback_failed` + `recovery_original_unhealthy` 表示恢复器已经执行过恢复流程，但未能在自己的恢复窗口内确认原发行健康。即使主机随后回到已审批原发行并在线，现有 reconcile 逻辑只清除恢复复核门，不终止原始 unknown 记录，导致用户只能重复恢复，而重复恢复又被远端拒绝。

## 目标

允许管理员在只读 reconcile 中闭环这一特例：

1. 远端 durable 回执必须是 `rollback_failed`。
2. 中心必须独立重新 probe，证明 Agent 身份、审批原发行指纹、运行模式、权限代次、helper 状态、服务状态和空闲围栏与审批完全一致。
3. 原始回执必须携带 `rollback_error_code=recovery_original_unhealthy`。
4. 成功后将原记录闭环为 `rolled_back`，保留原始 rollback error、当前 boot ID、指纹、核对时间和操作者。
5. 不重放 worker、恢复命令、安装、卸载或升级；不把 unknown 或漂移伪装成功。

## 非目标

- 不放宽任意 `rollback_failed` 的自动闭环；没有 `recovery_original_unhealthy` 或新鲜 probe 一致性时必须继续围栏。
- 不自动派发恢复或新升级。
- 不改变恢复事务 started-journal 续跑语义。
- 不清理历史审计。

## 验收

1. `rollback_failed + recovery_original_unhealthy` 且新鲜 probe 与审批一致时，只读 reconcile 将原记录置为 `rolled_back`。
2. probe 指纹、身份、运行模式、权限代次、helper、服务状态或生命周期锁任一不一致时拒绝，记录保持 unknown。
3. 回执缺少 `recovery_original_unhealthy` 时拒绝。
4. Runtime 回归、typecheck/build、版本检查和 diff check 通过。
