# 独立审查记录

审查日期：2026-10-30。范围：SDD 048 的计划规范化、中心调度、自动重试、Agent v2 执行参数、任务创建表单及 AI 提案边界。审查未操作生产、SSH、镜像或远端仓库。

## 发现与修复

| 级别 | 已复现的问题 | 最终处理与回归 |
| --- | --- | --- |
| P2 | 初次失败后生成自动重试，再修改任务代码，Agent 仍能领取旧版本快照。 | claim 对自动重试再次比较当前有效任务 revision 与快照；变化后记为 cancelled/task_revision_changed。`a queued automatic retry rechecks its approved definition again at Agent claim` 覆盖该时序。 |
| P2 | API/AI 可以创建空字符串、内嵌换行的字面参数；旧表单通过 join/split 回写会改变参数，trim 也会改变含边缘空格的合法目录。 | 参数编辑使用 JSON 字符串数组，目录保留原值；合并折叠区内未挂载字段，避免只改名称时清除参数或策略。浏览器回归覆盖 `['','first\nsecond',' space ']` 与末尾空格目录在只改名称后保持一致。 |
| P2 | 自动重试先取最早200条失败记录，再检查到期；200条长等待记录会阻塞其后已经到期的短等待重试。 | SQL 先筛选有重试授权、允许的失败码和已到期记录，再限制批次。`two hundred long-delay failures do not starve a later short-delay retry` 覆盖200条慢记录及其后的快记录。 |

同时复核了临近到期的一次计划修复：创建/修改计划在同一事务登记下一时刻；保存 now+2秒的 at 后，正常第5秒扫描能够执行。真正停机错过的时刻保持跳过。非法日期（例如2月30日）不会被 Date.parse 的日期规范化静默接受。

以上发现均已修复；本轮代码审查无未解决阻塞项。

## 关键边界复核

- `at` 按 task_id/run_at 持久消费；消费或错过后，修改名称、停用/启用、进程重启不会重放；重新安排需要新的未来时间。
- 调度默认每5秒扫描，正常扫描允许15秒迟到；启动前已经到期的槽即使仍处于该容差内也不补跑。循环计划推进未来时刻后再派发，避免历史补跑。
- preview 与 scheduler 共用 `nextTaskDates` 和固定 `cron-parser@5.10.2`。America/New_York 的春季缺失02:00移到03:00；秋季重复01:30只取第一次。闰日预览覆盖未来五个实际日期。
- 自动重试只处理 state=failed 且 code 为 `script_failed`、`runtime_unavailable`、`timeout`、`output_limit` 的明确回执；默认关闭，最多3次，沿用原快照并建立新记录。任务版本、目标、绑定、授权和取消状态在重试入队时检查，领取前再次核对适用守卫。
- unknown、控制丢失、租约过期、队列过期及取消不自动重试；人工重试仍审阅当前定义。
- args 以 argv 数组传入，cwd 直接交给 spawn，不拼接 shell；目录不存在时失败，不静默回退。非空 args/cwd 需要 task.script.v2，v1 Agent 不能静默丢弃选项。
- Node 脚本以临时 `.mjs` 文件运行，沿用 ESM；上传 `.js` 不会切换为 CommonJS。执行仍有超时、输出限制、清洁环境和进程组终止边界，不是操作系统沙箱。
- 上传后保存编辑器最终代码；类型及计划切换不会提交无关字段。内置 AI 继续使用相同 normalizeTask，仅生成所有者绑定的人工批准提案，没有直接 apply 或运行脚本工具。

## 验证证据与限制

审查者直接运行：

```sh
cd runtime
node --import tsx --test test/task-schedules.test.ts test/task-script-options.test.ts test/assistant-tasks.test.ts
node --import tsx --test test/task-schedules.test.ts
```

联合定向测试当时31/31通过；完成自动重试批次修复后，调度测试14/14通过。随后新增的闰日预览等最终联合回归由后端实施代理报告40/40通过；审查没有重复运行全量测试。

浏览器证据见 [ui-report.json](ui-report.json)：生产构建配合 API fixture，包含上传/编辑、计划切换、审阅保存、字面参数往返、既有模板与单机覆盖、390px 英文界面。该报告明确 `real_scheduler_execution=false`、`real_agent_execution=false`、`production_writes=false`；不能代替生产主机或发布验收。实际子进程行为由 runtime 定向测试覆盖。

## 文档一致性校对

已对照 [任务使用说明](../../docs/task-authoring.md)、[系统设计](../../docs/system-design.md) 第27节和本 SDD 的 spec/plan/contracts/tasks。Node ESM、一次计划消费、参数能力版本、人工批准边界与代码一致。

收尾文档需准确注明以下实现细节（已反馈整合者）：

1. `task_schedules` 保存 fingerprint/next_due；一次消费在独立的 `task_schedule_consumptions` 表，不应合并描述为同一张表。
2. 明确默认5秒扫描、15秒容差及启动前到期仍跳过；列明固定解析器的实际 DST 行为与自动重试失败码白名单。
3. 实施和验证完成后更新 SDD 状态、任务勾选；Doca 同步与回读由整合者单独提供证据，本文不替代在线同步确认。
