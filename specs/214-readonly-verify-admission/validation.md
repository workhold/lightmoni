# SDD214 验收记录

日期：2026-11-22。分支：`codex/214-readonly-verify-admission`。

## 生产证据（问题定位）

- zz-bj-1（root 模式，agent `13e088cf…`）自 2026-11-20 起累积 4 个未解决 unknown `task_runs`（最近一个 2026-11-22 02:47:50，与最后一次巡检回执同一时刻）；2276 条 succeeded/18 failed。
- `assertManagedJobAdmission` 因上述 unknown 拒绝该 Agent 全部新受管任务入队：0.1.21/0.1.22 表现为巡检断流（`ops_cluster_instances.last_seen` 全部冻结在 02:47、registry blocked、卡片降级待核实）；0.1.23 表现为 provider.reconcile 派发被拒 → `reconciliation_failed` 崩溃循环（`reconciliation_resources.failures` 0→6，起点即 0.1.23 部署时刻 14:09 UTC）。
- 镜像与部署链路验证：v0.1.23-20261122-140010-amd64 推送（digest `sha256:c3717ebf…`）后生产拉取完整、revision `778ca74c` 正确、容器 healthy。

## 行为

- 只读观测任务（`.inspect`/`.logs`）入队豁免 `assertManagedJobAdmission`；unknown `task_runs` 存在时巡检照常派发并经签名执行器完成，实例回 `running`；写任务仍被 `privileged_execution_pending` 拒绝直至人工核对。
- provider verify 派发被拒返回 `pending`/`verify_dispatch_deferred` 并 `logger.warn`，按退避重试。

## 本地验证

- 聚焦回归（`runtime/test/platform-status-truth.test.ts` 新增 2 条）：修复后 5 条全部通过；`git stash` 还原源码后新增 2 条失败（inspect 入队 409→资源 `reconciliation_failed`；派发拒绝→`reconciliation_failed`），恢复修复后通过。
- 受影响套件（platform-status-truth / agent-jobs / agent-job-fence / platform-clusters / reconciliation / managed-executor-jobs）162 项全部通过。
- `npm --prefix runtime run typecheck` 通过。
- 生产验证（0.1.24 部署后）：见下方补充。

## 生产验证（0.1.24）

- 待部署后补充：`ops_cluster_instances.last_seen` 恢复刷新、`reconciliation_resources` 4 项实例资源离开 `reconciliation_failed`、`/applications` 卡片回「运行中」；zz-bj-1 的 4 条 unknown `task_runs` 留待管理员按既有流程在 UI 核对（写围栏保持）。

## 0.1.26 部署验证与追加修复（FR-005）

- 0.1.26（仅含 FR-001/003）部署后：registry 侧 verify 派发成功（小猪绘本实例 `current_run_id` 已被新巡检覆盖，其余 3 实例资源离开 `reconciliation_failed` 转为 pending），但巡检卡在 agent_jobs `queued` 无人领取——受管链路还有两层围栏：
  1. 桥接 `enqueueManaged → idle()`：未解决 unknown 的 privileged job/task_run/agent_job 使 `machine_execution_locked`，只读巡检永远不被转换成 privileged job；
  2. 签名 claim 入口：执行器存在 running 或未解决 unknown 时整体 `return {job:null}`——zz-bj-1 自 02:47 起完全停止领取的直接原因；claim 循环内 `idle()` 亦不感知只读（会把只读任务取消为 `authorization_unavailable`）。
- FR-005 修复后聚焦回归（`managed-executor-jobs.test.ts` 新增「unresolved unknown managed outcome fences writes but read-only observations still bridge」）：stash 反向验证失败、恢复后通过；受影响 8 套件 201 项全部通过；typecheck 通过。

