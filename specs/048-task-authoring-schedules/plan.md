# 实施设计

- `runtime/src/server/task-schedule.ts`：规范化与持久化日历调度的纯函数，固定 Cron 库和 IANA 时区；preview 与 scheduler 复用。无其他调度队列或微服务。
- `nodes-model.ts`：扩展 TaskSchedule 和 TaskExecutionPolicy；元数据保存与 revision 纳入计划、脚本及执行策略。旧任务维持既有字段默认值，不重写历史快照。
- `task-center.ts`：中心计算下一次时间，持久化单次消费与重复触发去重，队列截止、全局并发与有界失败重试。原租约、取消、unknown、人工结束和 host/Agent 绑定不弱化。
- `shared/task-center.ts` 与 Agent runner：参数数组、绝对工作目录、`task.script.v2` 能力；继续支持基础 v1 任务，不在旧 Agent 静默降级新选项。
- Web：新建类型卡片、宽抽屉、脚本导入/编辑、计划控件与后端预览、目标预览、可折叠执行策略及提交审阅；保持原模板与主机覆盖入口。
- AI：继续调用 TaskProposalService 并通过同一 normalizeTask 校验，更新工具说明与文档契约，不伪造执行成功。
- 架构文档：更新系统设计任务章节，补充专门任务创建/调度说明与 Doca 对应内容；保留在线其他 PR 章节、原生图及无关块。
