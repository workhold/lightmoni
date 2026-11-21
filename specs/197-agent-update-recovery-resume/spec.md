# SDD 197：Agent 更新恢复事务可安全续跑

## 背景

Agent 显式恢复是 `switching`、`waiting_confirmation`、`rollback_failed` 等切换后状态的唯一审慎闭环路径。现有恢复流程先持久化 `recovery.json(status=started)`，再执行恢复动作并写最终回执。若恢复进程在 restore 中途崩溃，下一次恢复只看到 started journal 就返回 `recovery_interrupted`，导致原始更新记录长期停留在 `rollback_failed/unknown`，即使远端 Agent 已经回到可核对的旧发行也无法通过原生协议闭环。

## 目标

在极窄前提下允许续跑同一个已审批的 `restore_previous` 恢复事务：

1. journal 的 schema、审批摘要、action、source status 与当前更新回执完全匹配。
2. 仅 `restore_previous` 且原状态为 `switching`、`waiting_confirmation` 或 `rollback_failed` 可续跑；`archive_preparing` 不放宽。
3. 恢复前快照与当前回执一致，原/目标发行快照、launcher、service、helper 和卸载器快照完整，当前路径只能是审批原发行或审批目标发行。
4. worker 确认停止、生命周期锁仍归属原更新、Agent 身份/运行模式/权限代次未漂移，且没有其他操作锁。
5. 续跑仍执行停止、恢复固定快照、重启和原发行健康核验；成功后复用原 journal 的 `recovered_at/source_status` 写入 succeeded，并把更新状态闭环为 `rolled_back`。

## 非目标

- 不自动重试、不绕过管理员显式恢复、不重放原 update worker。
- 不把任何 unknown 改写为成功，不清理历史审计。
- 不改变中心 SQLite 权威记录、审批协议、SSH 凭据边界或批次暂停规则。
- 不承诺自动回滚或业务应用恢复成功。

## 验收

1. started `restore_previous` journal 在进程崩溃后，同一审批请求可在满足全部围栏时续跑并成功闭环。
2. 审批摘要、journal 状态、source status、当前回执、恢复前回执、原/目标快照、当前路径、worker 存活、锁归属或身份任一不匹配时拒绝，且不执行 stop/restart 或状态写入。
3. 最终写回执前失去响应后的重试保持幂等，不额外执行 restore。
4. 相关 runner 回归、Runtime 类型检查、构建、版本检查和 `git diff --check` 通过。
