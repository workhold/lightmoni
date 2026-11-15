# SDD 167 实施任务

- [x] T001 读取五台主机失败原因与原生审批 API/组件，确认已有维护、旧发行摘要和主机任务围栏分类。
- [x] T002 [US1][US2] 在 `web/src/features/assistant/agent-update-progress.test.mjs` 增加记录解析、审批资格、状态与 API 路径测试。
- [x] T003 [US1][US2] 新增 `web/src/features/assistant/AgentUpdateProgress.tsx`，复用计划摘要和原生 apply/cancel。
- [x] T004 [US1][US2] 修改 `web/src/features/assistant/AssistantPage.tsx`，接入更新计划审批与可读名称。
- [x] T005 [US3] 修改 `runtime/src/assistant/agent-updates.ts` 与 `runtime/src/assistant/types.ts`，要求刷新发行目录并限制错误后重试。
- [x] T006 运行相关 Runtime/Web/Agent 更新回归、类型检查、构建和文档检查，更新 validation。
- [ ] T007 同步 main、创建 PR；合入需另行授权，不直接 push main，不执行生产升级。
