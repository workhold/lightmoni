# SDD 170 实施任务

- [x] T001 复现历史摘要截断与更新卡片不刷新，核对 `vchive` 的 Agent 存在性、SSH 预检和 unknown 更新围栏。
- [x] T002 [US1] 修改 `ai-runtime/src/runner.ts`、Runtime 帧类型、Web 时间线和 AssistantPage，增加安全降级与展示。
- [x] T003 [US1] 在 `ai-runtime/test/worker.test.ts`、`runtime/test/assistant.test.ts`、`web/src/features/assistant/assistant.test.mjs` 增加四协议及时间线回归。
- [x] T004 [US2] 修改 `web/src/features/assistant/AgentUpdateProgress.tsx`，增加受控终态轮询和状态提示。
- [x] T005 [US2] 新增隔离 UI 验收，覆盖成功、失败、未知、读取失败保留和卸载停止轮询。
- [x] T006 [US3] 更新 `docs/system-design.md` 和本 SDD 验证记录，明确离线、存在性与 unknown 的不同语义。
- [x] T007 运行相关测试、类型检查、生产构建和文档检查，提交 PR 并按授权合入。
