# SDD 206：reconcile 的维护 worker 停止证据

## 背景

`vchive` 的回退失败记录已经满足 `rollback_failed + recovery_original_unhealthy`，原 0.1.8 程序健康在线。生产 0.1.12 的 reconcile 在清理残留 lifecycle lock 前只检查 systemd unit 的 is-active 和少量 PID 属性，返回 `recovery_worker_running`，导致安全闭环仍被阻塞。

## 目标

1. reconcile 使用与恢复 worker 相同方向的只读停止证据：无 active/activating/deactivating/reloading unit，无 MainPID/ControlPID/Job，无非预期 cgroup。
2. 检查 residual systemd cgroup 的 `cgroup.events.populated=0` 和 `cgroup.procs` 为空；unit not-found 且无 cgroup 时允许通过。
3. 只读核对确认 worker 停止后，继续执行既有、受窄条件限制的 lifecycle lock 清理，并再次核对原发行。
4. worker 证据持久化在 `lifecycle_lock_cleanup.worker_evidence`；不重放恢复、不清理其他锁。

## 非目标

- 不自动恢复维护。
- 不放宽原发行指纹、Agent 身份、服务健康或恢复修订复验。
- 不清理 operation lock、任务执行锁或其他业务锁。

## 验收

1. 单元停止但残留空 cgroup 时，reconcile 允许清理并闭环为 `rolled_back`。
2. unit active、cgroup populated、PID 残留或 cgroup 路径漂移时拒绝。
3. 成功清理回执包含 before/after 指纹、worker 证据和时间。
4. Runtime 回归通过；生产 `vchive` 读回 `rolled_back`。
