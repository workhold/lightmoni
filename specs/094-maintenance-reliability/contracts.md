# 契约

- `GET /machines/:id/agent-updates/:operation` 的 unknown 记录提供 `recovery_revision`，绑定操作、审批计划和当前平台固定维护器摘要，并提供持久的 `recovery_requires_verification` 门禁。
- `POST .../:operation/recover` 接收 `confirm:true`、`expected_revision`、可选 `credential_id`。只允许管理员、unknown 原事务和匹配修订；使用新的有效 SSH 凭据核验，但不改变已审批主机/Agent/程序/权限。拒绝未知字段。
- 固定维护器 `recover` 接收 operation_id、expected_agent_id、expected_fingerprint、expected_runtime_mode、expected_permission_generation 和 expected_target；由平台从审批记录产生，不能由用户提交任意路径或命令。
- 平台通过固定 SSH bootstrap 推送经摘要固定的维护器和请求，在 root 私有临时目录执行；使用主机级 flock 串行恢复。只读 reconcile 仍不触发恢复或再次提交。
- 恢复已派发但结果未核实时，`recovery_requires_verification=true`，再次 `recover` 返回 `409 / agent_update_recovery_verification_required`。GET 轮询、刷新、关闭再打开均不清除门禁；只有显式 `POST .../reconcile` 成功读取并核对原事务后，记录 `verification_completed_at/by/result_status` 并清除门禁。核对结果仍可为 unknown，不代表恢复成功；核对失败不清除门禁。
- 恢复前要求对应 systemd unit 无运行/控制 PID、无待启动 job，cgroup 无进程，且不存在本操作的 worker 进程。生命周期锁缺失时先取得本次锁；已有锁必须属于本次操作。失败不得解除别人的锁。
- accepted/preparing：原 current 路径、指纹、Agent 身份及服务健康全部一致才归档 failed/worker_interrupted_before_switch。switching/waiting_confirmation/rollback_failed：验证原快照和当前指针仅属于原/目标发行后，复用 restore；目标或原快照不明时继续 unknown，不改程序。
- 保留 worker claim、原状态备份、包、候选及恢复审计。已恢复但响应丢失可只读核对；重复显式恢复只能返回相同终态，不能重复切换或创建新执行。
- 缺失生命周期锁时，先原子取得本操作锁，再在锁内复核身份、权限代次、worker 停止、快照和任务；完成检查后才写 `recovery.json / started`。检查失败仅可释放本次新建且仍属于本操作的锁，不能解除其他操作或原有未知事务的锁。恢复自身在 started 后再次中断且尚无可验证终态时，保留锁与全部证据并返回 `recovery_interrupted`；不自动重放恢复或放行维护。
- `restore` 在写出 rolled_back 和解锁前，必须验证原路径、指纹、Agent 身份、运行身份/权限代次、本地发行、服务及 helper 健康。服务端另行执行独立 probe，证据一致后才归档 failed/rolled_back；任何复核失败均保持 unknown。`agent_update_recovery_unverified` 不能解释为“未执行恢复”。
- 丢失恢复响应后，`reconcile` 不能仅信任历史 failed/rolled_back 回执：必须重新 SSH probe，核对原程序指纹、Agent 身份、运行模式、权限代次、helper、原服务状态及无生命周期/任务锁，并在读取后再次确认审批计划、目标、账户与凭据修订；只有通过后才归档并记录 `current_verification`。切换前 worker 自然观察到服务停止的拒绝仍可只读归档 failed，但恢复审计存在时必须满足原审批服务状态。
- 平台在原维护回执的 `recovery_attempts` 中保留恢复操作者、时间、固定 runner SHA、审批修订、原审批账户、核验账户及凭据修订、派发与核对结果；只读 reconcile 不覆盖这份审计。
- 默认预算：准备 300 秒、worker 硬期限 1200 秒、平台观察 1260 秒；确认最长 180 秒。worker 准备超时、切换前余量不足均在原服务上安全失败。
- 实际 systemd 维护单元使用 `MemoryHigh=384M` 回收阈值、`MemoryMax=512M` 硬限、`MemorySwapMax=0`、`CPUQuota=50%`、`TasksMax=64`、`RuntimeMaxSec=1200`。准备阶段空间和 inode 准入仍独立执行；这些资源限额不承诺任何主机或任意制品均可成功维护。
- 生产 `ExecStopPost` 只保存小型 `unit-exit.json`，记录归一的 `result/exit_code/exit_status` 及可用的 `memory_peak_bytes`；它不修改事务 status、不提交成功、不恢复程序、不解除生命周期锁。不可捕获退出不能承诺执行 Node finally。
- 客户端 GET 使用既有 agentOperationReadSignal；写请求不得自动超时重发，回读失败不重复 apply/recover。
