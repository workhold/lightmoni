# SDD 176 验收记录

日期：2026-11-16。仅记录已实际完成的步骤。

## 对照上游

- 分支基于 main `b051140f`（含 PR #234 `889f0be8` SDD173 恢复运行时选择与助手内联审批、PR #235/#236 0.1.2 发行）。经 `git show 889f0be8` 逐文件比对：SDD173 范围为恢复运行时选择、probe/status 的恢复启动、助手卡片与 409 `agent_recovery_runtime_unavailable` 文案；与本 SDD 四个用户场景（keep_current 终结、busy 车道可观测、围栏 409 细分、恢复投影补全）无重叠。

## 实现

- `runtime/src/server/machine-maintenance.ts`：新增 `maintenanceBlockers`（只读明细，每类上限 8 项），`maintenanceWorkBusy` 布尔查询逐字节未变。
- `runtime/src/server/machine-busy-lane.ts`（新）：`BusyLane` 类型、`holdBusy`、持有者中文标签。
- `runtime/src/server/managed-machines.ts`：busy `Set`→`Map<string,{holder,since}>`；四个加锁点分别标注 terminal/ssh-check/installation/deployment；`idle()` 409 带持有者与起始时间；新增 `GET /api/v1/machines/:id/busy`、`POST /api/v1/machines/:id/busy/release`（confirm+reason，幂等，`machine_busy_release` 结构化日志）。
- `runtime/src/server/machine-agent-updates.ts`：`AgentUpdateAccess.busy` 类型更新，全部加锁点经 `holdLane`（agent-update）；`validateProbe` 按四个失败前提细分固定消息；`validateOriginalProbe` 保留 `agent_update_recovery_unverified` 前缀并注明漂移维度；reconcile 新增 `resolution=keep_current`（启动窗口闸 + 目标发行闸 + 服务状态闸 + 受管健康/无锁闸），终结为 failed 并保存 `manual_keep_current` 证据与 `keep_current` 事件，路由校验 reason 非空 ≤500 且跳过 `markRecoveryVerification`；taskBusy 409 列出阻塞明细。
- `runtime/src/server/machine-agent-runtime.ts`、`machine-docker.ts`、`machine-installation-recovery.ts`、`machine-state-recovery.ts`、`machine-uninstallations.ts`：加锁点迁移至 `holdBusy`（agent-runtime/docker/installation-recovery/state-recovery/uninstallation）。
- `runtime/src/ops/cluster-workloads.ts`：应用实例恢复投影 SELECT 增加 `job_id`、`observed_at`。
- `web/src/app/agent-update-model.ts`：新增六条固定消息键映射（probe 细分四条 + keep_current 终结文案）。
- `docs/system-design.md`：§28.6 追加 SDD176 段落；§105 投影句补 job_id/observed_at。

## 验证

- Runtime 类型检查通过；Web `tsc --noEmit` 通过。
- 定向回归：`machine-maintenance.test.ts` + `machine-agent-updates.test.ts` 89/89（含新增 maintenanceBlockers 与 keep_current 用例）；`managed-machines.test.ts` 含新增 busy 车道查询/释放用例；`machine-agent-runtime`、`machine-state-recovery`、`docker-environment`、`agent-recovery-runtime`、`assistant-agent-updates`、`agent-update-ssh-probe`、`machine-installation-recovery(-races)`、`agent-runtime-maintenance`、`platform-clusters` 全部通过。
- 新增测试：`keep_current resolution terminalizes a drifted unknown only with verified evidence`（覆盖漂移 409 保持、resolution/reason 校验 400、目标发行闸拒绝、服务状态闸拒绝、成功终结与证据/事件/围栏释放、终态不可再核对）；`busy lane reports holder and since, and an admin release with confirm and reason clears it`；`maintenance blockers expose actionable detail without changing the fence`。
- 已知主干既有失败：`managed-machines.test.ts` 的 `unbound host must prove registered remote node and cannot uninstall a different or busy node`（state=queued 断言 201≠409）——经 `git stash` 在未修改工作树上复现同一失败（85 pass/1 fail），与本次改动无关，与 SDD172 记录的主干既有失败一致。
- 生产构建 `npm run build`（sdk/typescript、runtime、ai-runtime、web）通过；`npm run version:check` 46/46 通过（当前 0.1.2）；`git diff --check` 通过。
- 恢复投影 `job_id/observed_at` 为既有行对象的列追加（类型检查覆盖），端到端断言依赖 publish 时机未在单测中固化，留待发行部署后线上核对（应用实例 recovery 字段出现 job_id/observed_at）。
