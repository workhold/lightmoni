# SDD 176 任务清单

- [x] T1 对照 SDD173 差异确认范围（无重叠）
- [x] T2 spec/plan/contracts 成文
- [x] T3 `machine-maintenance.ts`：`maintenanceBlockers` 明细函数（`maintenanceWorkBusy` 不变）
- [x] T4 `machine-agent-updates.ts`：keep_current 分支 + 路由 body 扩展 + validateProbe/validateOriginalProbe 消息细分 + taskBusy 明细 + busy Map 适配
- [x] T5 `managed-machines.ts`：busy Map + 持有者标注 + idle 消息 + busy 查询/释放路由
- [x] T6 `cluster-workloads.ts`：recovery 投影补 `job_id/observed_at`
- [x] T7 `web/src/app/agent-update-model.ts`：新增固定消息键映射
- [x] T8 测试：maintenance blockers、keep_current 正反例、busy 路由、消息断言
- [x] T9 类型检查 + 定向回归 + 生产构建 + version:check + `git diff --check`
- [x] T10 `docs/system-design.md` §28 更新
- [x] T11 validation.md 记录证据
