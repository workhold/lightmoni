# SDD 176 实施计划

对照上游 SDD 173（PR #234，889f0be8）：其范围是恢复运行时选择与助手内联审批卡片，与本 SDD 四个用户场景无重叠；本分支基于 main 实现，提交前已变基合入 SDD175（stale-agent-enrollment-recovery）。

## 方案

1. **US1 keep_current**：`runtime/src/server/machine-agent-updates.ts`
   - `reconcile` 增加参数 `resolution?` / `reason?` / `actor?`；`keep_current` 分支置于 `access.busy` 持有之后、status 命令之前。
   - 路由 body 允许 `resolution/reason`；`resolution` 必须是 `keep_current` 且 reason 非空 ≤500；使用时不执行 `markRecoveryVerification`。
   - 终结 UPDATE 与既有 failed 终结同构：`ticket_hash=''`、`finished_at`、receipt 追加 `manual_keep_current`、追加 `keep_current` 事件。
2. **US2 busy Map**：`runtime/src/server/managed-machines.ts`
   - `busy: Set` → `busy: Map<string,{holder,since}>`；新增 `hold(id,holder)` 辅助；五个加锁点分别传入 terminal/ssh-check/installation/deployment/agent-update。
   - `idle()` 409 带持有者与起始时间；`Map.has` 与原 `Set.has` 兼容，能力投影无需改动。
   - 新路由 `GET /api/v1/machines/:id/busy`、`POST /api/v1/machines/:id/busy/release`（confirm+reason，幂等，`deps.logger.warn` 审计）。
   - `runtime/src/server/machine-agent-updates.ts` 中 `access.busy.add/delete` 全部改为 `Map.set({holder:'agent-update'})/delete`。
3. **US3 围栏消息**：
   - `validateProbe` 拆分为四个失败前提的固定消息；`validateOriginalProbe` 409 保留错误码前缀并追加漂移维度。
   - `runtime/src/server/machine-maintenance.ts` 新增 `maintenanceBlockers`（只读明细，最多 8 项），`maintenanceWorkBusy` 保持原查询不变；Agent 维护 `assertTarget` 的 409 用明细增强。
4. **US4 投影补全**：`runtime/src/ops/cluster-workloads.ts` publish() 的 recovery SELECT 增加 `job_id,observed_at`。

## 测试

- `runtime/test/machine-maintenance.test.ts`：blockers 明细。
- `runtime/test/machine-agent-updates.test.ts`：keep_current 正/反例、reason 校验、probe 细分消息、taskBusy 明细消息；harness `access.busy` 适配 Map。
- managed-machines 侧：busy 查询/释放路由与 idle 消息的定向断言（复用现有主机 harness）。
- `runtime/test/` 中既有 `agent_update_recovery_unverified` 断言用正则匹配前缀，保持通过。

## 文档与架构

- `docs/system-design.md` §28.5/§28.6 追加：keep_current 出口、busy 车道持有者/释放接口、围栏消息明细原则；reconciliation 清单节（§reconciliation_resources 投影）补 job_id/observed_at 透出一句。
- 架构影响判断：涉及 API 面（busy 查询/释放、reconcile body 扩展）与组件职责（busy 车道可观测），属架构变更，同一 PR 更新本文档。

## 验证顺序

类型检查 → 定向测试（maintenance / agent-updates / managed-machines 相关）→ 生产构建 → version:check → `git diff --check`。
