# SDD214：只读观测豁免受管准入围栏

**分支**：`codex/214-readonly-verify-admission`
**日期**：2026-11-22
**状态**：已实施

## 背景

SDD213（PR #305，0.1.23）部署生产后验证发现：自动只读核实仍无法派发。生产 zz-bj-1（root 模式）自 2026-11-20 起累积 4 个未解决的 unknown `task_runs`（受管桥接任务丢租约产生，最近一个 2026-11-22 02:47:50），`assertManagedJobAdmission`（`runtime/src/server/privileged-execution-guard.ts`）对该 Agent 的**一切**新受管任务入队返回 409。后果：

- 0.1.21/0.1.22：registry 返回 blocked，巡检断流，`last_seen` 冻结在 02:47，可用性新鲜度过期，卡片降级「待核实」——即生产 /applications 状态误报的直接根因，唯一恢复手段是人工「修复 Agent」。
- 0.1.23：unknown-locked 改为自动 verify 后，verify 派发在入队处被同一围栏拒绝，provider.reconcile 抛异常被 registry 吞成 `reconciliation_failed` 崩溃循环（failures 0→6，起点即部署时刻）。

设计文档第 116 章已为受管执行器确立「只读 inspect 可核对 unknown」的原则；本规格把同一原则延伸到普通任务入队路径的准入围栏。

## 用户场景与验收

1. 给定 root 模式 Agent 存在未解决的 unknown `task_runs`，当中心为其实例派发只读观测任务（`workload.inspect`/`gateway.inspect`/`node.inspect`/`registry.inspect`/`instance.recovery.inspect`/`*.logs`）时，入队成功并正常走受管桥接执行；巡检回执恢复实例状态与 `last_seen`，无需人工修复。
2. 给定同样围栏，写任务（apply/stop/remove 等）入队仍被 `privileged_execution_pending` 拒绝——unknown 写结果的人工审核闭环不变。
3. 给定 provider.reconcile 中 verify/repair 的派发因准入或通道原因被拒（HTTPError），调和资源返回 `pending`（`verify_dispatch_deferred`）并按既有退避重试，不再表现为 `reconciliation_failed` 崩溃循环；其他意外异常记录告警日志。

## 要求

- **FR-001**：`store.queue` 依据 `config.task` 将只读观测任务标记传入 `jobs.enqueue`；`enqueue` 对该类受管任务跳过 `assertManagedJobAdmission`，其余围栏（生命周期、卸载、Agent 更新、安装、执行器就绪）完全不变。
- **FR-002**：写任务的准入行为与错误码不变。
- **FR-003**：registry provider 的 verify 派发失败返回 `pending`/`verify_dispatch_deferred` 并 `logger.warn` 记录原因；成功路径与既有 proof 消费不变。
- **FR-004**：回归测试覆盖验收 1–3，且在未修复代码上失败。

## 架构影响

**适用**（控制路径准入条件变化）：受管任务准入围栏对只读观测豁免、调和器派发失败语义，更新 `docs/system-design.md`（第 116/213 章相关边界）。凭据边界、存储、协议结构、部署拓扑不变。

## 非目标

- 不改变 unknown 写任务/任务中心 task_run 的人工核对与审核流程（specs/192/203/205/206 边界）。
- 不自动解决既有 unknown `task_runs`（生产 4 条留待管理员在 UI 按既有流程核对）。
- 不改动受管桥接 `prepare()` 的排队/取消语义（SDD205）。
